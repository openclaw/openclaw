import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveSessionKeyForRequest } from "./session.runtime.js";

type SessionStoreMap = Record<string, { sessionId: string; updatedAt: number }>;
const mocks = vi.hoisted(() => ({
  stores: new Map<string, SessionStoreMap>(),
  listSessionEntriesReadOnly: vi.fn(),
  resolveStorePath: vi.fn(),
  listAgentIds: vi.fn(),
  resolveExplicitAgentSessionKey: vi.fn(),
}));

vi.mock("../../config/sessions/main-session.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions/main-session.js")>(
    "../../config/sessions/main-session.js",
  );
  return { ...actual, resolveExplicitAgentSessionKey: mocks.resolveExplicitAgentSessionKey };
});

// mock-isolation: Session-resolution fixtures own the synthetic store inventory and exact rows.
vi.mock("../../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntryReadOnlyInWorker: async (scope: { storePath: string; sessionKey: string }) =>
    structuredClone(mocks.stores.get(scope.storePath)?.[scope.sessionKey]),
  withSessionStoreReaderInWorker: async (
    scope: { agentId?: string; storePath?: string },
    consume: (source: unknown) => unknown,
  ) =>
    consume({
      database: { agentId: scope.agentId, path: scope.storePath },
      reader: {
        readExactEntries: async (request: { selection: { sessionIdOrKey: string } }) => ({
          entries: mocks
            .listSessionEntriesReadOnly(scope)
            .filter(
              ({ entry }: { entry: { sessionId: string } }) =>
                entry.sessionId === request.selection.sessionIdOrKey,
            ),
        }),
      },
    }),
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: mocks.resolveStorePath,
}));

// mock-isolation: Session routing uses a synthetic agent inventory and fixture-selected default.
vi.mock("../../agents/agent-scope.js", async () => {
  const { normalizeAgentId } = await vi.importActual<typeof import("../../routing/session-key.js")>(
    "../../routing/session-key.js",
  );
  return {
    listAgentIds: mocks.listAgentIds,
    resolveDefaultAgentId: (cfg: OpenClawConfig) =>
      normalizeAgentId(Object.keys(cfg.agents?.entries ?? {})[0]),
  };
});

describe("resolveSessionKeyForRequest", () => {
  const MAIN_STORE_PATH = "/tmp/main-store.json";
  const MYBOT_STORE_PATH = "/tmp/mybot-store.json";
  const SHARED_STORE_PATH = "/tmp/shared-store.json";
  const mainKey = "agent:main:main";
  const mybotKey = "agent:mybot:main";
  const row = (sessionId: string, updatedAt = 0) => ({ sessionId, updatedAt });
  const mybotCfg: OpenClawConfig = { agents: { entries: { mybot: {} } } };
  const resolve = (request: Partial<Parameters<typeof resolveSessionKeyForRequest>[0]>) =>
    resolveSessionKeyForRequest({ cfg: {}, ...request });
  const mockAgentStores = (main: SessionStoreMap = {}, mybot: SessionStoreMap = {}) => {
    mocks.listAgentIds.mockReturnValue(["main", "mybot"]);
    mocks.resolveStorePath.mockImplementation(
      (_store: string | undefined, opts?: { agentId?: string }) =>
        opts?.agentId === "mybot" ? MYBOT_STORE_PATH : MAIN_STORE_PATH,
    );
    mocks.stores.set(MAIN_STORE_PATH, main).set(MYBOT_STORE_PATH, mybot);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.stores.clear();
    mocks.listSessionEntriesReadOnly.mockImplementation(({ storePath }: { storePath: string }) =>
      Object.entries(mocks.stores.get(storePath) ?? {}).map(([sessionKey, entry]) => ({
        sessionKey,
        entry,
      })),
    );
    mocks.listAgentIds.mockReturnValue(["main"]);
    mocks.resolveStorePath.mockReturnValue(MAIN_STORE_PATH);
    mocks.resolveExplicitAgentSessionKey.mockReturnValue(undefined);
  });

  it("uses an agent-scoped --to value as the requested session key", async () => {
    const sessionKey = "agent:main:openclaw-weixin:direct:o9cq802hhmfc@im.wechat";
    mocks.stores.set(MAIN_STORE_PATH, { [sessionKey]: row("wechat-session") });
    expect((await resolve({ to: sessionKey })).sessionKey).toBe(sessionKey);
  });

  it("canonicalizes an explicit main alias for the selected agent", async () => {
    mockAgentStores();
    expect(
      await resolve({ cfg: { ...mybotCfg, session: { mainKey: "work" } }, sessionKey: "main" }),
    ).toMatchObject({ sessionKey: "agent:mybot:work", storePath: MYBOT_STORE_PATH });
  });

  it("does not adopt another agent's main session from a literal shared store", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "mybot"]);
    mocks.resolveStorePath.mockReturnValue(SHARED_STORE_PATH);
    mocks.stores.set(SHARED_STORE_PATH, { [mainKey]: row("legacy-session-id", 1) });
    const cfg = { ...mybotCfg, session: { store: SHARED_STORE_PATH } };
    const result = await resolve({ cfg, to: "+15551234567" });
    expect(result).toMatchObject({
      sessionKey: mybotKey,
      storePath: SHARED_STORE_PATH,
      sessionEntry: undefined,
    });
    expect(mocks.listSessionEntriesReadOnly).not.toHaveBeenCalled();
  });

  it.each([
    ["uses the configured default agent", mybotCfg, undefined],
    ["finds a session ID in another agent's store", {}, "current-session-id"],
  ] as const)("%s", async (_name, cfg, sessionId) => {
    const current = row("current-session-id", 2);
    mockAgentStores({ [mainKey]: row("legacy-session-id", 1) }, { [mybotKey]: current });
    const result = await resolve({ cfg, to: "+15551234567", sessionId });
    expect(result).toMatchObject({ sessionKey: mybotKey, storePath: MYBOT_STORE_PATH });
    expect(result.sessionEntry).toEqual(current);
  });

  it("does not let --agent short-circuit --session-id back to the agent main session", async () => {
    const targetKey = "agent:mybot:whatsapp:direct:+15551234567";
    mocks.resolveExplicitAgentSessionKey.mockReturnValue(mybotKey);
    mockAgentStores(
      {},
      { [mybotKey]: row("other-session-id"), [targetKey]: row("target-session-id", 1) },
    );
    expect(await resolve({ agentId: "mybot", sessionId: "target-session-id" })).toMatchObject({
      sessionKey: targetKey,
      storePath: MYBOT_STORE_PATH,
    });
  });

  it("does not search other agent stores when --agent scopes --session-id", async () => {
    mockAgentStores({ "agent:main:whatsapp:direct:+15550000000": row("target-session-id", 10) });
    expect(await resolve({ agentId: "mybot", sessionId: "target-session-id" })).toMatchObject({
      sessionKey: "agent:mybot:explicit:target-session-id",
      storePath: MYBOT_STORE_PATH,
    });
    const agentsRead = mocks.listSessionEntriesReadOnly.mock.calls.map(([scope]) => scope.agentId);
    expect(agentsRead).toEqual(["mybot"]);
  });

  it("does not search other stores when explicitSessionKey is set", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "mybot"]);
    mocks.stores.set(MAIN_STORE_PATH, { [mainKey]: row("other-id") });
    const result = await resolve({ sessionKey: mainKey, sessionId: "target-session-id" });
    expect(result.sessionKey).toBe(mainKey);
  });
});
