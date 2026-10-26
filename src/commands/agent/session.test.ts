import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveSessionKeyForRequest } from "./session.runtime.js";

const mocks = vi.hoisted(() => ({
  listSessionEntriesReadOnly: vi.fn(),
  loadExactSessionEntryReadOnly: vi.fn(),
  resolveStorePath: vi.fn(),
  listAgentIds: vi.fn(),
  resolveExplicitAgentSessionKey: vi.fn(),
}));

vi.mock("../../config/sessions/main-session.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions/main-session.js")>(
    "../../config/sessions/main-session.js",
  );
  return {
    ...actual,
    resolveExplicitAgentSessionKey: mocks.resolveExplicitAgentSessionKey,
  };
});

// mock-isolation: Session-resolution fixtures own the synthetic store inventory and exact rows.
vi.mock("../../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntryReadOnlyInWorker: async (scope: { storePath: string; sessionKey: string }) =>
    mocks.loadExactSessionEntryReadOnly(scope)?.entry,
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
  type SessionStoreEntry = { sessionId: string; updatedAt: number };
  type SessionStoreMap = Record<string, SessionStoreEntry>;
  const row = (sessionId: string, updatedAt = 0): SessionStoreEntry => ({ sessionId, updatedAt });
  const mybotCfg: OpenClawConfig = { agents: { entries: { mybot: {} } } };
  const resolve = (request: Partial<Parameters<typeof resolveSessionKeyForRequest>[0]>) =>
    resolveSessionKeyForRequest({ cfg: {}, ...request });
  const mockAgentStores = (main: SessionStoreMap = {}, mybot: SessionStoreMap = {}) => {
    mocks.listAgentIds.mockReturnValue(["main", "mybot"]);
    mocks.resolveStorePath.mockImplementation(
      (_store: string | undefined, opts?: { agentId?: string }) =>
        opts?.agentId === "mybot" ? MYBOT_STORE_PATH : MAIN_STORE_PATH,
    );
    mockStoresByPath({ [MAIN_STORE_PATH]: main, [MYBOT_STORE_PATH]: mybot });
  };

  const mockStoresByPath = (stores: Partial<Record<string, SessionStoreMap>>) => {
    mocks.loadExactSessionEntryReadOnly.mockImplementation(
      ({ storePath, sessionKey }: { storePath: string; sessionKey: string }) => {
        const entry = stores[storePath]?.[sessionKey];
        return entry ? { sessionKey, entry: structuredClone(entry) } : undefined;
      },
    );
    mocks.listSessionEntriesReadOnly.mockImplementation((scope?: { storePath?: string }) =>
      Object.entries(stores[scope?.storePath ?? ""] ?? {}).map(([sessionKey, entry]) => ({
        sessionKey,
        entry,
      })),
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadExactSessionEntryReadOnly.mockReset();
    mocks.listAgentIds.mockReturnValue(["main"]);
    mocks.resolveStorePath.mockReturnValue(MAIN_STORE_PATH);
    mocks.resolveExplicitAgentSessionKey.mockReturnValue(undefined);
  });

  it("uses an agent-scoped --to value as the requested session key", async () => {
    const sessionKey = "agent:main:openclaw-weixin:direct:o9cq802hhmfc@im.wechat";
    mockStoresByPath({ [MAIN_STORE_PATH]: { [sessionKey]: row("wechat-session") } });
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
    mockStoresByPath({ [SHARED_STORE_PATH]: { [mainKey]: row("legacy-session-id", 1) } });
    expect(
      await resolve({
        cfg: { ...mybotCfg, session: { store: SHARED_STORE_PATH } },
        to: "+15551234567",
      }),
    ).toMatchObject({
      sessionKey: mybotKey,
      storePath: SHARED_STORE_PATH,
      sessionEntry: undefined,
    });
    expect(mocks.listSessionEntriesReadOnly).not.toHaveBeenCalled();
  });

  it("prefers the configured default-agent session over legacy main-store rows", async () => {
    const current = row("current-session-id", 2);
    mockAgentStores({ [mainKey]: row("legacy-session-id", 1) }, { [mybotKey]: current });
    const result = await resolve({ cfg: mybotCfg, to: "+15551234567" });
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
    expect(mocks.listSessionEntriesReadOnly).toHaveBeenCalledTimes(1);
    expect(mocks.listSessionEntriesReadOnly).toHaveBeenCalledWith({
      agentId: "mybot",
      storePath: MYBOT_STORE_PATH,
      sessionId: "target-session-id",
    });
  });

  it("does not search other stores when explicitSessionKey is set", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "mybot"]);
    mockStoresByPath({ [MAIN_STORE_PATH]: { [mainKey]: row("other-id") } });
    expect(
      (await resolve({ sessionKey: mainKey, sessionId: "target-session-id" })).sessionKey,
    ).toBe(mainKey);
  });

  it("searches other stores when --to derives a key that does not match --session-id", async () => {
    mockAgentStores(
      { [mainKey]: row("other-session-id") },
      { [mybotKey]: row("target-session-id") },
    );
    expect(await resolve({ to: "+15551234567", sessionId: "target-session-id" })).toMatchObject({
      sessionKey: mybotKey,
      storePath: MYBOT_STORE_PATH,
    });
  });
});
