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
  type SessionStoreEntry = { sessionId: string; updatedAt: number };
  type SessionStoreMap = Record<string, SessionStoreEntry>;
  const row = (sessionId: string, updatedAt = 0): SessionStoreEntry => ({ sessionId, updatedAt });
  const mybotCfg: OpenClawConfig = { agents: { entries: { mybot: {} } } };
  const resolve = (request: Partial<Parameters<typeof resolveSessionKeyForRequest>[0]>) =>
    resolveSessionKeyForRequest({ cfg: {}, ...request });

  const setupMainAndMybotStorePaths = () => {
    mocks.listAgentIds.mockReturnValue(["main", "mybot"]);
    mocks.resolveStorePath.mockImplementation(
      (_store: string | undefined, opts?: { agentId?: string }) =>
        opts?.agentId === "mybot" ? MYBOT_STORE_PATH : MAIN_STORE_PATH,
    );
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
    const result = await resolve({ to: sessionKey });
    expect(result.sessionKey).toBe(sessionKey);
  });

  it("canonicalizes an explicit main alias for the selected agent", async () => {
    setupMainAndMybotStorePaths();
    mockStoresByPath({});
    const result = await resolve({
      cfg: { ...mybotCfg, session: { mainKey: "work" } },
      sessionKey: "main",
    });

    expect(result).toMatchObject({ sessionKey: "agent:mybot:work", storePath: MYBOT_STORE_PATH });
  });

  it("does not adopt another agent's main session from a literal shared store", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "mybot"]);
    mocks.resolveStorePath.mockReturnValue(SHARED_STORE_PATH);
    mockStoresByPath({ [SHARED_STORE_PATH]: { "agent:main:main": row("legacy-session-id", 1) } });
    const result = await resolve({
      cfg: { ...mybotCfg, session: { store: SHARED_STORE_PATH } },
      to: "+15551234567",
    });

    expect(result).toMatchObject({ sessionKey: "agent:mybot:main", storePath: SHARED_STORE_PATH });
    expect(result.sessionEntry).toBeUndefined();
    expect(mocks.listSessionEntriesReadOnly).not.toHaveBeenCalled();
  });

  it("prefers the configured default-agent session over legacy main-store rows", async () => {
    setupMainAndMybotStorePaths();
    const current = row("current-session-id", 2);
    mockStoresByPath({
      [MAIN_STORE_PATH]: { "agent:main:main": row("legacy-session-id", 1) },
      [MYBOT_STORE_PATH]: { "agent:mybot:main": current },
    });

    const result = await resolve({ cfg: mybotCfg, to: "+15551234567" });
    expect(result).toMatchObject({ sessionKey: "agent:mybot:main", storePath: MYBOT_STORE_PATH });
    expect(result.sessionEntry).toEqual(current);
  });

  it("does not let --agent short-circuit --session-id back to the agent main session", async () => {
    setupMainAndMybotStorePaths();
    mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:mybot:main");
    mockStoresByPath({
      [MYBOT_STORE_PATH]: {
        "agent:mybot:main": row("other-session-id"),
        "agent:mybot:whatsapp:direct:+15551234567": row("target-session-id", 1),
      },
    });

    const result = await resolve({ agentId: "mybot", sessionId: "target-session-id" });
    expect(result).toMatchObject({
      sessionKey: "agent:mybot:whatsapp:direct:+15551234567",
      storePath: MYBOT_STORE_PATH,
    });
  });

  it("does not search other agent stores when --agent scopes --session-id", async () => {
    setupMainAndMybotStorePaths();
    mockStoresByPath({
      [MAIN_STORE_PATH]: {
        "agent:main:whatsapp:direct:+15550000000": row("target-session-id", 10),
      },
      [MYBOT_STORE_PATH]: {},
    });

    const result = await resolve({ agentId: "mybot", sessionId: "target-session-id" });
    expect(result).toMatchObject({
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

  it("returns a deterministic explicit sessionKey when sessionId not found in any store", async () => {
    setupMainAndMybotStorePaths();
    mocks.listSessionEntriesReadOnly.mockReturnValue([]);
    const result = await resolve({ sessionId: "nonexistent-id" });
    expect(result.sessionKey).toBe("agent:main:explicit:nonexistent-id");
  });

  it("does not search other stores when explicitSessionKey is set", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "mybot"]);
    mockStoresByPath({ [MAIN_STORE_PATH]: { "agent:main:main": row("other-id") } });
    const result = await resolve({
      sessionKey: "agent:main:main",
      sessionId: "target-session-id",
    });
    expect(result.sessionKey).toBe("agent:main:main");
  });

  it("searches other stores when --to derives a key that does not match --session-id", async () => {
    setupMainAndMybotStorePaths();
    mockStoresByPath({
      [MAIN_STORE_PATH]: { "agent:main:main": row("other-session-id") },
      [MYBOT_STORE_PATH]: { "agent:mybot:main": row("target-session-id") },
    });
    const result = await resolve({ to: "+15551234567", sessionId: "target-session-id" });
    expect(result).toMatchObject({ sessionKey: "agent:mybot:main", storePath: MYBOT_STORE_PATH });
  });
});
