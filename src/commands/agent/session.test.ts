import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveSessionKeyForRequest } from "./session.js";

const mocks = vi.hoisted(() => ({
  listSessionEntries: vi.fn(),
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

vi.mock("../../config/sessions/store.js", () => ({
  listSessionEntries: mocks.listSessionEntries,
}));

vi.mock("../../agents/agent-scope.js", async () => {
  const { normalizeAgentId } = await vi.importActual<typeof import("../../routing/session-key.js")>(
    "../../routing/session-key.js",
  );
  return {
    listAgentIds: mocks.listAgentIds,
    resolveDefaultAgentId: (cfg: OpenClawConfig) => {
      const agents = cfg.agents?.list ?? [];
      return normalizeAgentId(agents.find((agent) => agent?.default)?.id ?? agents[0]?.id);
    },
  };
});

describe("resolveSessionKeyForRequest", () => {
  type SessionStoreEntry = { sessionId: string; updatedAt: number };
  type SessionStoreMap = Record<string, SessionStoreEntry>;

  const setupMainAndMybotStores = () => {
    mocks.listAgentIds.mockReturnValue(["main", "mybot"]);
  };

  const mockStoresByAgent = (stores: Partial<Record<string, SessionStoreMap>>) => {
    mocks.listSessionEntries.mockImplementation(({ agentId }: { agentId: string }) =>
      Object.entries(stores[agentId] ?? {}).map(([sessionKey, entry]) => ({
        sessionKey,
        entry,
      })),
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAgentIds.mockReturnValue(["main"]);
    mockStoresByAgent({});
    mocks.resolveExplicitAgentSessionKey.mockReturnValue(undefined);
  });

  const baseCfg: OpenClawConfig = {};

  it("returns sessionKey when --to resolves a session key via context", async () => {
    mockStoresByAgent({
      main: {
        "agent:main:main": { sessionId: "sess-1", updatedAt: 0 },
      },
    });

    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      to: "+15551234567",
    });
    expect(result.sessionKey).toBe("agent:main:main");
  });

  it("uses the configured default agent store for new --to sessions", async () => {
    setupMainAndMybotStores();
    mockStoresByAgent({ main: {}, mybot: {} });

    const result = resolveSessionKeyForRequest({
      cfg: {
        agents: { list: [{ id: "mybot", default: true }] },
      } satisfies OpenClawConfig,
      to: "+15551234567",
    });

    expect(result.sessionKey).toBe("agent:mybot:main");
    expect(result.agentId).toBe("mybot");
  });

  it("does not migrate legacy main-store main-key sessions during runtime resolution", async () => {
    setupMainAndMybotStores();
    const mainStore = {
      "agent:main:main": { sessionId: "legacy-session-id", updatedAt: 1 },
    };
    const mybotStore = {};
    mockStoresByAgent({
      main: mainStore,
      mybot: mybotStore,
    });

    const result = resolveSessionKeyForRequest({
      cfg: {
        agents: { list: [{ id: "mybot", default: true }] },
      } satisfies OpenClawConfig,
      to: "+15551234567",
    });

    expect(result.sessionKey).toBe("agent:mybot:main");
    expect(result.sessionStore).toEqual({});
    expect(result.agentId).toBe("mybot");
    expect(result.sessionStore["agent:mybot:main"]?.sessionId).toBeUndefined();
  });

  it("does not duplicate legacy main-key sessions during runtime resolution with a shared store", async () => {
    const sharedStore = {
      "agent:main:main": { sessionId: "legacy-session-id", updatedAt: 1 },
    };
    mocks.listAgentIds.mockReturnValue(["main", "mybot"]);
    mockStoresByAgent({
      main: sharedStore,
      mybot: sharedStore,
    });

    const result = resolveSessionKeyForRequest({
      cfg: {
        agents: { list: [{ id: "mybot", default: true }] },
      } satisfies OpenClawConfig,
      to: "+15551234567",
    });

    expect(result.sessionKey).toBe("agent:mybot:main");
    expect(result.sessionStore).toEqual({
      "agent:main:main": { sessionId: "legacy-session-id", updatedAt: 1 },
    });
    expect(result.agentId).toBe("mybot");
    expect(result.sessionStore["agent:mybot:main"]?.sessionId).toBeUndefined();
    expect(mocks.listSessionEntries).toHaveBeenCalledTimes(1);
    expect(mocks.listSessionEntries).toHaveBeenCalledWith({ agentId: "mybot" });
  });

  it("prefers the configured default-agent session over legacy main-store rows", async () => {
    setupMainAndMybotStores();
    const mybotStore = {
      "agent:mybot:main": { sessionId: "current-session-id", updatedAt: 2 },
    };
    mockStoresByAgent({
      main: {
        "agent:main:main": { sessionId: "legacy-session-id", updatedAt: 1 },
      },
      mybot: mybotStore,
    });

    const result = resolveSessionKeyForRequest({
      cfg: {
        agents: { list: [{ id: "mybot", default: true }] },
      } satisfies OpenClawConfig,
      to: "+15551234567",
    });

    expect(result.sessionKey).toBe("agent:mybot:main");
    expect(result.sessionStore).toEqual(mybotStore);
    expect(result.agentId).toBe("mybot");
  });

  it("finds session by sessionId via reverse lookup in primary store", async () => {
    mockStoresByAgent({
      main: {
        "agent:main:main": { sessionId: "target-session-id", updatedAt: 0 },
      },
    });

    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      sessionId: "target-session-id",
    });
    expect(result.sessionKey).toBe("agent:main:main");
  });

  it("finds session by sessionId in non-primary agent store", async () => {
    setupMainAndMybotStores();
    mockStoresByAgent({
      mybot: {
        "agent:mybot:main": { sessionId: "target-session-id", updatedAt: 0 },
      },
    });

    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      sessionId: "target-session-id",
    });
    expect(result.sessionKey).toBe("agent:mybot:main");
    expect(result.agentId).toBe("mybot");
  });

  it("does not let --agent short-circuit --session-id back to the agent main session", async () => {
    setupMainAndMybotStores();
    mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:mybot:main");
    mockStoresByAgent({
      mybot: {
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
    expect(result.agentId).toBe("mybot");
  });

  it("treats whitespace --session-id as absent when resolving --agent", async () => {
    setupMainAndMybotStores();
    mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:mybot:main");
    mockStoresByAgent({
      mybot: {
        "agent:mybot:main": { sessionId: "existing-session-id", updatedAt: 1 },
      },
    });

    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      agentId: "mybot",
      sessionId: "   ",
    });

    expect(result.sessionKey).toBe("agent:mybot:main");
    expect(result.agentId).toBe("mybot");
  });

  it("does not search other agent stores when --agent scopes --session-id", async () => {
    setupMainAndMybotStores();
    mockStoresByAgent({
      main: {
        "agent:main:whatsapp:direct:+15550000000": {
          sessionId: "target-session-id",
          updatedAt: 10,
        },
      },
      mybot: {},
    });

    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      agentId: "mybot",
      sessionId: "target-session-id",
    });

    expect(result.sessionKey).toBe("agent:mybot:explicit:target-session-id");
    expect(result.agentId).toBe("mybot");
    expect(mocks.listSessionEntries).toHaveBeenCalledTimes(1);
    expect(mocks.listSessionEntries).toHaveBeenCalledWith({ agentId: "mybot" });
  });

  it("returns correct sessionStore when session found in non-primary agent store", async () => {
    const mybotStore = {
      "agent:mybot:main": { sessionId: "target-session-id", updatedAt: 0 },
    };
    setupMainAndMybotStores();
    mockStoresByAgent({
      mybot: { ...mybotStore },
    });

    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      sessionId: "target-session-id",
    });
    expect(result.sessionStore["agent:mybot:main"]?.sessionId).toBe("target-session-id");
  });

  it("returns a deterministic explicit sessionKey when sessionId not found in any store", async () => {
    setupMainAndMybotStores();
    mockStoresByAgent({});

    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      sessionId: "nonexistent-id",
    });
    expect(result.sessionKey).toBe("agent:main:explicit:nonexistent-id");
  });

  it("does not search other stores when explicitSessionKey is set", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "mybot"]);
    mockStoresByAgent({
      main: {
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

  it("searches other stores when --to derives a key that does not match --session-id", async () => {
    setupMainAndMybotStores();
    mockStoresByAgent({
      main: {
        "agent:main:main": { sessionId: "other-session-id", updatedAt: 0 },
      },
      mybot: {
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
    expect(result.agentId).toBe("mybot");
  });

  it("skips already-searched primary store when iterating agents", async () => {
    setupMainAndMybotStores();
    mockStoresByAgent({});

    resolveSessionKeyForRequest({
      cfg: baseCfg,
      sessionId: "nonexistent-id",
    });

    const agentIds = mocks.listSessionEntries.mock.calls.map((call) => call[0]?.agentId);
    expect(agentIds).toHaveLength(2);
    expect(agentIds).toContain("main");
    expect(agentIds).toContain("mybot");
  });
});
