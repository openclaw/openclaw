// Agent session helper tests cover explicit session resolution through config and session stores.
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

vi.mock("../../config/sessions/session-accessor.js", () => ({
  listSessionEntriesReadOnly: mocks.listSessionEntriesReadOnly,
  loadExactSessionEntryReadOnly: mocks.loadExactSessionEntryReadOnly,
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: mocks.resolveStorePath,
}));

vi.mock("../../agents/agent-scope.js", async () => {
  const { normalizeAgentId } = await vi.importActual<typeof import("../../routing/session-key.js")>(
    "../../routing/session-key.js",
  );
  return {
    listAgentIds: mocks.listAgentIds,
    resolveDefaultAgentId: (cfg: OpenClawConfig) => {
      return normalizeAgentId(Object.keys(cfg.agents?.entries ?? {})[0]);
    },
  };
});

describe("resolveSessionKeyForRequest", () => {
  const MAIN_STORE_PATH = "/tmp/main-store.json";
  const MYBOT_STORE_PATH = "/tmp/mybot-store.json";
  const SHARED_STORE_PATH = "/tmp/shared-store.json";
  type SessionStoreEntry = { sessionId: string; updatedAt: number };
  type SessionStoreMap = Record<string, SessionStoreEntry>;

  const setupMainAndMybotStorePaths = () => {
    mocks.listAgentIds.mockReturnValue(["main", "mybot"]);
    mocks.resolveStorePath.mockImplementation(
      (_store: string | undefined, opts?: { agentId?: string }) => {
        if (opts?.agentId === "mybot") {
          return MYBOT_STORE_PATH;
        }
        return MAIN_STORE_PATH;
      },
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
    mocks.resolveExplicitAgentSessionKey.mockReturnValue(undefined);
  });

  const baseCfg: OpenClawConfig = {};

  it("uses an agent-scoped --to value as the requested session key", () => {
    const sessionKey = "agent:main:openclaw-weixin:direct:o9cq802hhmfc@im.wechat";
    mocks.resolveStorePath.mockReturnValue(MAIN_STORE_PATH);
    mockStoresByPath({
      [MAIN_STORE_PATH]: {
        [sessionKey]: { sessionId: "wechat-session", updatedAt: 0 },
      },
    });

    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      to: sessionKey,
    });

    expect(result.sessionKey).toBe(sessionKey);
  });

  it("canonicalizes an explicit main alias for the selected agent", () => {
    setupMainAndMybotStorePaths();
    mockStoresByPath({
      [MAIN_STORE_PATH]: {},
      [MYBOT_STORE_PATH]: {},
    });

    const result = resolveSessionKeyForRequest({
      cfg: {
        agents: { entries: { mybot: {} } },
        session: { mainKey: "work" },
      } satisfies OpenClawConfig,
      sessionKey: "main",
    });

    expect(result.sessionKey).toBe("agent:mybot:work");
    expect(result.storePath).toBe(MYBOT_STORE_PATH);
  });

  it("does not adopt another agent's main session from a literal shared store", () => {
    const sharedStore = {
      "agent:main:main": { sessionId: "legacy-session-id", updatedAt: 1 },
    };
    mocks.listAgentIds.mockReturnValue(["main", "mybot"]);
    mocks.resolveStorePath.mockReturnValue(SHARED_STORE_PATH);
    mockStoresByPath({ [SHARED_STORE_PATH]: sharedStore });

    const result = resolveSessionKeyForRequest({
      cfg: {
        agents: { entries: { mybot: {} } },
        session: { store: SHARED_STORE_PATH },
      } satisfies OpenClawConfig,
      to: "+15551234567",
    });

    expect(result.sessionKey).toBe("agent:mybot:main");
    expect(result.sessionEntry).toBeUndefined();
    expect(result.storePath).toBe(SHARED_STORE_PATH);
    expect(mocks.listSessionEntriesReadOnly).not.toHaveBeenCalled();
  });

  it("prefers the configured default-agent session over legacy main-store rows", () => {
    setupMainAndMybotStorePaths();
    const mybotStore = {
      "agent:mybot:main": { sessionId: "current-session-id", updatedAt: 2 },
    };
    mockStoresByPath({
      [MAIN_STORE_PATH]: {
        "agent:main:main": { sessionId: "legacy-session-id", updatedAt: 1 },
      },
      [MYBOT_STORE_PATH]: mybotStore,
    });

    const result = resolveSessionKeyForRequest({
      cfg: {
        agents: { entries: { mybot: {} } },
      } satisfies OpenClawConfig,
      to: "+15551234567",
    });

    expect(result.sessionKey).toBe("agent:mybot:main");
    expect(result.sessionEntry).toEqual(mybotStore["agent:mybot:main"]);
    expect(result.storePath).toBe(MYBOT_STORE_PATH);
  });

  it("does not let --agent short-circuit --session-id back to the agent main session", () => {
    setupMainAndMybotStorePaths();
    mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:mybot:main");
    mockStoresByPath({
      [MYBOT_STORE_PATH]: {
        "agent:mybot:main": { sessionId: "other-session-id", updatedAt: 0 },
        "agent:mybot:whatsapp:direct:+15551234567": {
          sessionId: "target-session-id",
          updatedAt: 1,
        },
      },
    });

    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      agentId: "mybot",
      sessionId: "target-session-id",
    });

    expect(result.sessionKey).toBe("agent:mybot:whatsapp:direct:+15551234567");
    expect(result.storePath).toBe(MYBOT_STORE_PATH);
  });

  it("does not search other agent stores when --agent scopes --session-id", () => {
    setupMainAndMybotStorePaths();
    mockStoresByPath({
      [MAIN_STORE_PATH]: {
        "agent:main:whatsapp:direct:+15550000000": {
          sessionId: "target-session-id",
          updatedAt: 10,
        },
      },
      [MYBOT_STORE_PATH]: {},
    });

    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      agentId: "mybot",
      sessionId: "target-session-id",
    });

    expect(result.sessionKey).toBe("agent:mybot:explicit:target-session-id");
    expect(result.storePath).toBe(MYBOT_STORE_PATH);
    expect(mocks.listSessionEntriesReadOnly).toHaveBeenCalledTimes(1);
    expect(mocks.listSessionEntriesReadOnly).toHaveBeenCalledWith({
      agentId: "mybot",
      storePath: MYBOT_STORE_PATH,
      clone: false,
    });
  });

  it("returns a deterministic explicit sessionKey when sessionId not found in any store", () => {
    setupMainAndMybotStorePaths();
    mocks.listSessionEntriesReadOnly.mockReturnValue([]);

    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      sessionId: "nonexistent-id",
    });
    expect(result.sessionKey).toBe("agent:main:explicit:nonexistent-id");
  });

  it("does not search other stores when explicitSessionKey is set", () => {
    mocks.listAgentIds.mockReturnValue(["main", "mybot"]);
    mocks.resolveStorePath.mockReturnValue(MAIN_STORE_PATH);
    mockStoresByPath({
      [MAIN_STORE_PATH]: {
        "agent:main:main": { sessionId: "other-id", updatedAt: 0 },
      },
    });

    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      sessionKey: "agent:main:main",
      sessionId: "target-session-id",
    });
    // explicitSessionKey is set, so sessionKey comes from it, not from sessionId lookup
    expect(result.sessionKey).toBe("agent:main:main");
  });

  it("searches other stores when --to derives a key that does not match --session-id", () => {
    setupMainAndMybotStorePaths();
    mockStoresByPath({
      [MAIN_STORE_PATH]: {
        "agent:main:main": { sessionId: "other-session-id", updatedAt: 0 },
      },
      [MYBOT_STORE_PATH]: {
        "agent:mybot:main": { sessionId: "target-session-id", updatedAt: 0 },
      },
    });

    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      to: "+15551234567",
      sessionId: "target-session-id",
    });
    // --to derives agent:main:main, but its sessionId doesn't match target-session-id,
    // so the cross-store search finds it in the mybot store
    expect(result.sessionKey).toBe("agent:mybot:main");
    expect(result.storePath).toBe(MYBOT_STORE_PATH);
  });
});
