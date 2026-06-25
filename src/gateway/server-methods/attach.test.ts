import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config/sessions/session-accessor.js", async (importActual) => ({
  ...(await importActual<typeof import("../../config/sessions/session-accessor.js")>()),
  loadSessionEntry: vi.fn(() => undefined),
  // Run the atomic mutator on an entry that already holds ANOTHER provider's binding, returning the
  // result — so the test actually exercises the merge (a non-preserving handler would drop other-cli)
  // instead of the mock masking it. Returns null only when explicitly overridden (write-failed case).
  patchSessionEntry: vi.fn(async (_scope: unknown, update: (entry: unknown) => unknown) =>
    update({ cliSessionBindings: { "other-cli": { sessionId: "other-sess" } } }),
  ),
}));

import { hashCliSessionText } from "../../agents/cli-session.js";
import { loadSessionEntry, patchSessionEntry } from "../../config/sessions/session-accessor.js";
import { resetAttachGrantsForTest, resolveAttachGrant } from "../mcp-grant-store.js";
import { closeMcpLoopbackServer } from "../mcp-http.js";
import { attachHandlers } from "./attach.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const grantOpts = (sessionKey: string, respond: ReturnType<typeof vi.fn>, cwd?: string) =>
  ({
    params: { sessionKey, ...(cwd ? { cwd } : {}) },
    respond,
    context: { getRuntimeConfig: () => ({}) },
  }) as unknown as GatewayRequestHandlerOptions;

describe("attach gateway methods", () => {
  beforeEach(() => resetAttachGrantsForTest());
  afterEach(async () => {
    resetAttachGrantsForTest();
    // attach.grant lazily starts the loopback singleton; close it so it doesn't leak across files.
    await closeMcpLoopbackServer();
  });

  it("attach.grant mints a session-bound grant and returns loopback config + token env", async () => {
    const respond = vi.fn();
    await attachHandlers["attach.grant"](grantOpts("agent:main:attach-method", respond));

    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, payload] = respond.mock.calls[0];
    expect(ok).toBe(true);
    const body = payload as {
      token: string;
      sessionKey: string;
      mcpConfig: unknown;
      env: Record<string, string>;
    };
    expect(body.sessionKey).toBe("agent:main:attach-method");
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.mcpConfig).toBeTruthy();
    expect(body.env.OPENCLAW_MCP_TOKEN).toBe(body.token);
    expect(body.env.OPENCLAW_MCP_SESSION_KEY).toBe("agent:main:attach-method");
    // the minted token resolves to the bound session in the shared store
    expect(resolveAttachGrant(body.token)?.sessionKey).toBe("agent:main:attach-method");
  });

  it("attach.revoke removes a grant; missing token is an INVALID_REQUEST", async () => {
    const grantRespond = vi.fn();
    await attachHandlers["attach.grant"](grantOpts("agent:main:revoke-me", grantRespond));
    const token = (grantRespond.mock.calls[0][1] as { token: string }).token;

    const revokeRespond = vi.fn();
    await attachHandlers["attach.revoke"]({
      params: { token },
      respond: revokeRespond,
    } as unknown as GatewayRequestHandlerOptions);
    expect(revokeRespond).toHaveBeenCalledWith(true, { revoked: true });
    expect(resolveAttachGrant(token)).toBeUndefined();

    const errRespond = vi.fn();
    await attachHandlers["attach.revoke"]({
      params: {},
      respond: errRespond,
    } as unknown as GatewayRequestHandlerOptions);
    const [errOk, , err] = errRespond.mock.calls[0];
    expect(errOk).toBe(false);
    expect((err as { code: string }).code).toBe("INVALID_REQUEST");
  });

  it("applies a positive ttlMs and falls back to the default for an invalid one", async () => {
    const r1 = vi.fn();
    await attachHandlers["attach.grant"]({
      params: { sessionKey: "agent:main:ttl", ttlMs: 30_000 },
      respond: r1,
      context: { getRuntimeConfig: () => ({}) },
    } as unknown as GatewayRequestHandlerOptions);
    const now1 = Date.now();
    const b1 = r1.mock.calls[0][1] as { expiresAtMs: number };
    expect(b1.expiresAtMs).toBeGreaterThan(now1 + 20_000);
    expect(b1.expiresAtMs).toBeLessThan(now1 + 40_000); // honored 30s ttl, not the 1h default

    const r2 = vi.fn();
    await attachHandlers["attach.grant"]({
      params: { sessionKey: "agent:main:ttl2", ttlMs: -5 }, // non-positive → default ttl
      respond: r2,
      context: { getRuntimeConfig: () => ({}) },
    } as unknown as GatewayRequestHandlerOptions);
    const b2 = r2.mock.calls[0][1] as { expiresAtMs: number };
    expect(b2.expiresAtMs).toBeGreaterThan(Date.now() + 50 * 60_000); // ~1h default window
  });

  it("attach.revoke treats non-object params as a missing token (INVALID_REQUEST)", async () => {
    const respond = vi.fn();
    await attachHandlers["attach.revoke"]({
      params: null,
      respond,
    } as unknown as GatewayRequestHandlerOptions);
    const [ok, , err] = respond.mock.calls[0];
    expect(ok).toBe(false);
    expect((err as { code: string }).code).toBe("INVALID_REQUEST");
  });

  it("attach.grant returns resumeSessionId only when the bound cwd matches (claude scopes per project)", async () => {
    vi.mocked(loadSessionEntry).mockReturnValue({
      cliSessionBindings: {
        "claude-cli": { sessionId: "bound-uuid", cwdHash: hashCliSessionText("/proj") },
      },
    } as never);

    const sameCwd = vi.fn();
    await attachHandlers["attach.grant"](grantOpts("agent:main:resume", sameCwd, "/proj"));
    expect((sameCwd.mock.calls[0][1] as { resumeSessionId?: string }).resumeSessionId).toBe(
      "bound-uuid",
    );

    const otherCwd = vi.fn();
    await attachHandlers["attach.grant"](grantOpts("agent:main:resume", otherCwd, "/elsewhere"));
    expect(
      (otherCwd.mock.calls[0][1] as { resumeSessionId?: string }).resumeSessionId,
    ).toBeUndefined();
  });

  it("attach.adopt persists the claude-cli binding and preserves other providers' bindings", async () => {
    const grantRespond = vi.fn();
    await attachHandlers["attach.grant"](grantOpts("agent:main:adopt", grantRespond));
    const token = (grantRespond.mock.calls[0][1] as { token: string }).token;

    const adoptRespond = vi.fn();
    await attachHandlers["attach.adopt"]({
      params: { token, cliSessionId: "sess-uuid-1", cwd: "/proj" },
      respond: adoptRespond,
    } as unknown as GatewayRequestHandlerOptions);

    expect(adoptRespond).toHaveBeenCalledWith(true, {
      sessionKey: "agent:main:adopt",
      cliSessionId: "sess-uuid-1",
      persisted: true,
    });
    // the atomic mutator ran on an entry already holding "other-cli" (see the mock) — both survive,
    // and the new binding records the cwd hash so resume is gated per project.
    const persistedEntry = (await vi.mocked(patchSessionEntry).mock.results.at(-1)?.value) as {
      cliSessionBindings: Record<string, { sessionId: string; cwdHash?: string }>;
    };
    expect(persistedEntry.cliSessionBindings["claude-cli"].sessionId).toBe("sess-uuid-1");
    expect(persistedEntry.cliSessionBindings["claude-cli"].cwdHash).toBe(
      hashCliSessionText("/proj"),
    );
    expect(persistedEntry.cliSessionBindings["other-cli"].sessionId).toBe("other-sess"); // preserved
  });

  it("attach.adopt reports persisted:false when the store write returns null", async () => {
    vi.mocked(patchSessionEntry).mockResolvedValueOnce(null);
    const grantRespond = vi.fn();
    await attachHandlers["attach.grant"](grantOpts("agent:main:np", grantRespond));
    const token = (grantRespond.mock.calls[0][1] as { token: string }).token;

    const r = vi.fn();
    await attachHandlers["attach.adopt"]({
      params: { token, cliSessionId: "s" },
      respond: r,
    } as unknown as GatewayRequestHandlerOptions);
    expect(r).toHaveBeenCalledWith(true, {
      sessionKey: "agent:main:np",
      cliSessionId: "s",
      persisted: false,
    });
  });

  it("attach.adopt rejects a missing field or unknown grant as INVALID_REQUEST", async () => {
    const r1 = vi.fn();
    await attachHandlers["attach.adopt"]({
      params: { token: "x" }, // missing cliSessionId
      respond: r1,
    } as unknown as GatewayRequestHandlerOptions);
    expect((r1.mock.calls[0][2] as { code: string }).code).toBe("INVALID_REQUEST");

    const r2 = vi.fn();
    await attachHandlers["attach.adopt"]({
      params: { token: "nonexistent", cliSessionId: "s" }, // unknown grant
      respond: r2,
    } as unknown as GatewayRequestHandlerOptions);
    expect((r2.mock.calls[0][2] as { code: string }).code).toBe("INVALID_REQUEST");
  });
});
