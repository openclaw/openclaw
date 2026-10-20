import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAttachGrant } from "../mcp-grant-store.js";
import { closeMcpLoopbackServer } from "../mcp-http.js";
import { attachHandlers } from "./attach.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";

const loadSessionEntryMock = vi.hoisted(() =>
  vi.fn((_sessionKey: string) => ({ entry: undefined as Record<string, unknown> | undefined })),
);

vi.mock("../../config/sessions/session-accessor.entry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../config/sessions/session-accessor.entry.js")>();
  return {
    ...actual,
    readResolvedSessionEntryInWorker: async (params: { sessionKey: string }) =>
      loadSessionEntryMock(params.sessionKey).entry,
  };
});

const grant = expectDefined(attachHandlers["attach.grant"], "attach.grant handler");
const revoke = expectDefined(attachHandlers["attach.revoke"], "attach.revoke handler");

async function request(params: Record<string, unknown>, handler = grant, config = {}) {
  const respond = vi.fn<RespondFn>();
  await handler({
    params,
    respond,
    context: { getRuntimeConfig: () => config },
  } as unknown as GatewayRequestHandlerOptions);
  expect(respond).toHaveBeenCalledTimes(1);
  return expectDefined(respond.mock.calls[0], "attach response");
}

describe("attach gateway methods", () => {
  beforeEach(() => {
    loadSessionEntryMock.mockReset();
    loadSessionEntryMock.mockReturnValue({ entry: undefined });
  });
  afterEach(async () => {
    // attach.grant lazily starts the loopback singleton; close it so it doesn't leak across files.
    await closeMcpLoopbackServer();
  });

  it("attach.grant mints a session-bound grant and returns loopback config + token env", async () => {
    const [ok, payload] = await request({ sessionKey: "agent:main:attach-method" });
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
    expect(Object.keys(body.env)).toEqual(["OPENCLAW_MCP_TOKEN"]);
    const placeholders = [...JSON.stringify(body.mcpConfig).matchAll(/\$\{([A-Z0-9_]+)\}/gu)].map(
      (match) => match[1],
    );
    expect(new Set(placeholders)).toEqual(new Set(Object.keys(body.env)));
    expect(resolveAttachGrant(body.token)?.sessionKey).toBe("agent:main:attach-method");
  });

  it("uses an explicit agent for an omitted session key", async () => {
    const [ok, payload] = await request({ agentId: "research" }, grant, {
      agents: { ownership: "explicit", entries: { research: {}, other: {} } },
    });
    expect(ok).toBe(true);
    const result = payload as { sessionKey?: string } | undefined;
    expect(result?.sessionKey).toBe("agent:research:main");
  });
  it("rejects attach grants for reserved harness sessions", async () => {
    const [ok, , error] = await request({
      sessionKey: "agent:main:harness:codex:supervision:native-thread",
    });
    expect(ok).toBe(false);
    expect(error).toMatchObject({ code: "INVALID_REQUEST" });
    expect((error as { message: string }).message).toContain("reserved");
  });

  it("allows an existing unlocked legacy harness-prefixed session", async () => {
    loadSessionEntryMock.mockReturnValue({
      entry: { sessionId: "legacy-session", modelSelectionLocked: false },
    });
    const sessionKey = "agent:main:harness:legacy-notes";
    const [ok, payload] = await request({ sessionKey });
    expect(ok).toBe(true);
    const response = payload as { token: string } | undefined;
    expect(response).toBeDefined();
    const token = response?.token ?? "";
    expect(resolveAttachGrant(token)?.sessionKey).toBe(sessionKey);
  });

  it("rejects attach grants for existing locked harness sessions", async () => {
    loadSessionEntryMock.mockReturnValue({
      entry: {
        sessionId: "locked-session",
        agentHarnessId: "codex",
        modelSelectionLocked: true,
      },
    });
    const [ok, , error] = await request({
      sessionKey: "agent:main:harness:codex:supervision:native-thread",
    });
    expect(ok).toBe(false);
    expect(error).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("reserved"),
    });
  });

  it("attach.revoke removes a grant; missing token is an INVALID_REQUEST", async () => {
    const [, payload] = await request({ sessionKey: "agent:main:revoke-me" });
    const { token } = payload as { token: string };
    expect(await request({ token }, revoke)).toEqual([true, { revoked: true }]);
    expect(resolveAttachGrant(token)).toBeUndefined();

    const [errOk, , err] = await request({}, revoke);
    expect(errOk).toBe(false);
    expect((err as { code: string }).code).toBe("INVALID_REQUEST");
  });

  it("applies a positive ttlMs and falls back to the default for an invalid one", async () => {
    const [, first] = await request({ sessionKey: "agent:main:ttl", ttlMs: 30_000 });
    const b1 = first as { expiresAtMs: number };
    const now1 = Date.now();
    expect(b1.expiresAtMs).toBeGreaterThan(now1 + 20_000);
    expect(b1.expiresAtMs).toBeLessThan(now1 + 40_000); // honored 30s ttl, not the 1h default

    const [, second] = await request({ sessionKey: "agent:main:ttl2", ttlMs: -5 });
    const b2 = second as { expiresAtMs: number };
    expect(b2.expiresAtMs).toBeGreaterThan(Date.now() + 50 * 60_000);
  });
});
