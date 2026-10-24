import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

beforeEach(() => {
  loadSessionEntryMock.mockReset();
  loadSessionEntryMock.mockReturnValue({ entry: undefined });
});
afterEach(closeMcpLoopbackServer);

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
  expect(body.env).toEqual({ OPENCLAW_MCP_TOKEN: body.token });
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
it.each([
  ["reserved", undefined, false],
  [
    "locked",
    { sessionId: "locked-session", agentHarnessId: "codex", modelSelectionLocked: true },
    false,
  ],
  ["legacy", { sessionId: "legacy-session", modelSelectionLocked: false }, true],
] as const)("enforces attach authority for %s harness sessions", async (_name, entry, allowed) => {
  loadSessionEntryMock.mockReturnValue({ entry });
  const sessionKey = allowed
    ? "agent:main:harness:legacy-notes"
    : "agent:main:harness:codex:supervision:native-thread";
  const [ok, payload, error] = await request({ sessionKey });
  expect(ok).toBe(allowed);
  if (allowed) {
    const response = payload as { token: string } | undefined;
    expect(response).toBeDefined();
    expect(resolveAttachGrant(response?.token ?? "")?.sessionKey).toBe(sessionKey);
  } else {
    expect(error).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("reserved"),
    });
  }
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
