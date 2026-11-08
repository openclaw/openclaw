import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveAttachGrant } from "../mcp-grant-store.js";
import { closeMcpLoopbackServer } from "../mcp-http.js";
import { attachHandlers } from "./attach.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";

const loadSessionEntryMock = vi.hoisted(() =>
  vi.fn<(_sessionKey: string) => Record<string, unknown> | undefined>(),
);

vi.mock("../../config/sessions/session-accessor.entry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../config/sessions/session-accessor.entry.js")>();
  return {
    ...actual,
    readResolvedSessionEntryInWorker: async (params: { sessionKey: string }) =>
      loadSessionEntryMock(params.sessionKey),
  };
});

const grant = expectDefined(attachHandlers["attach.grant"], "attach.grant handler");
const revoke = expectDefined(attachHandlers["attach.revoke"], "attach.revoke handler");
type Grant = NonNullable<ReturnType<typeof resolveAttachGrant>> & {
  mcpConfig: unknown;
  env: Record<string, string>;
};

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

beforeEach(() => loadSessionEntryMock.mockReset());
afterEach(closeMcpLoopbackServer);

it.each([30_000, -5])("attach.grant binds its config and token with ttlMs=%s", async (ttlMs) => {
  const [ok, payload] = await request({ sessionKey: "agent:main:attach-method", ttlMs });
  expect(ok).toBe(true);
  const body = payload as Grant;
  expect(body.sessionKey).toBe("agent:main:attach-method");
  expect(body.token).toMatch(/^[0-9a-f]{64}$/);
  expect(body.env).toEqual({ OPENCLAW_MCP_TOKEN: body.token });
  const placeholders = [...JSON.stringify(body.mcpConfig).matchAll(/\$\{([A-Z0-9_]+)\}/gu)].map(
    (match) => match[1],
  );
  expect(new Set(placeholders)).toEqual(new Set(Object.keys(body.env)));
  expect(resolveAttachGrant(body.token)?.sessionKey).toBe("agent:main:attach-method");
  const now = Date.now();
  expect(body.expiresAtMs).toBeGreaterThan(now + (ttlMs > 0 ? 20_000 : 50 * 60_000));
  if (ttlMs > 0) {
    expect(body.expiresAtMs).toBeLessThan(now + 40_000);
  }
});

it("uses an explicit agent for an omitted session key", async () => {
  const [ok, payload] = await request({ agentId: "research" }, grant, {
    agents: { ownership: "explicit", entries: { research: {}, other: {} } },
  });
  expect(ok).toBe(true);
  expect(payload).toMatchObject({ sessionKey: "agent:research:main" });
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
  loadSessionEntryMock.mockReturnValue(entry);
  const sessionKey = allowed
    ? "agent:main:harness:legacy-notes"
    : "agent:main:harness:codex:supervision:native-thread";
  const [ok, payload, error] = await request({ sessionKey });
  expect(ok).toBe(allowed);
  if (allowed) {
    const response = expectDefined(payload, "attach grant") as Grant;
    expect(resolveAttachGrant(response.token)?.sessionKey).toBe(sessionKey);
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
  expect(err).toMatchObject({ code: "INVALID_REQUEST" });
});
