import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const mocks = vi.hoisted(() => ({
  loadSessionStore: vi.fn(),
  resolveStorePath: vi.fn(),
  listAgentIds: vi.fn(),
}));

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    loadSessionStore: mocks.loadSessionStore,
    resolveStorePath: mocks.resolveStorePath,
  };
});

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: mocks.listAgentIds,
}));

const { resolveSession, resolveSessionKeyForRequest } = await import("./session.js");

describe("resolveSessionKeyForRequest", () => {
  const MAIN_STORE_PATH = "/tmp/main-store.json";
  const MYBOT_STORE_PATH = "/tmp/mybot-store.json";
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
    mocks.loadSessionStore.mockImplementation((storePath: string) => stores[storePath] ?? {});
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAgentIds.mockReturnValue(["main"]);
  });

  const baseCfg: OpenClawConfig = {};

  it("returns sessionKey when --to resolves a session key via context", async () => {
    mocks.resolveStorePath.mockReturnValue(MAIN_STORE_PATH);
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:main": { sessionId: "sess-1", updatedAt: 0 },
    });

    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      to: "+15551234567",
    });
    expect(result.sessionKey).toBe("agent:main:main");
  });

  it("finds session by sessionId via reverse lookup in primary store", async () => {
    mocks.resolveStorePath.mockReturnValue(MAIN_STORE_PATH);
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:main": { sessionId: "target-session-id", updatedAt: 0 },
    });

    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      sessionId: "target-session-id",
    });
    expect(result.sessionKey).toBe("agent:main:main");
  });

  it("finds session by sessionId in non-primary agent store", async () => {
    setupMainAndMybotStorePaths();
    mockStoresByPath({
      [MYBOT_STORE_PATH]: {
        "agent:mybot:main": { sessionId: "target-session-id", updatedAt: 0 },
      },
    });

    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      sessionId: "target-session-id",
    });
    expect(result.sessionKey).toBe("agent:mybot:main");
    expect(result.storePath).toBe(MYBOT_STORE_PATH);
  });

  it("returns correct sessionStore when session found in non-primary agent store", async () => {
    const mybotStore = {
      "agent:mybot:main": { sessionId: "target-session-id", updatedAt: 0 },
    };
    setupMainAndMybotStorePaths();
    mockStoresByPath({
      [MYBOT_STORE_PATH]: { ...mybotStore },
    });

    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      sessionId: "target-session-id",
    });
    expect(result.sessionStore["agent:mybot:main"]?.sessionId).toBe("target-session-id");
  });

  it("returns undefined sessionKey when sessionId not found in any store", async () => {
    setupMainAndMybotStorePaths();
    mocks.loadSessionStore.mockReturnValue({});

    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      sessionId: "nonexistent-id",
    });
    expect(result.sessionKey).toBeUndefined();
  });

  it("does not search other stores when explicitSessionKey is set", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "mybot"]);
    mocks.resolveStorePath.mockReturnValue(MAIN_STORE_PATH);
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:main": { sessionId: "other-id", updatedAt: 0 },
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

  it("skips already-searched primary store when iterating agents", async () => {
    setupMainAndMybotStorePaths();
    mocks.loadSessionStore.mockReturnValue({});

    resolveSessionKeyForRequest({
      cfg: baseCfg,
      sessionId: "nonexistent-id",
    });

    // loadSessionStore should be called twice: once for main, once for mybot
    // (not twice for main)
    const storePaths = mocks.loadSessionStore.mock.calls.map((call) => String(call[0]));
    expect(storePaths).toHaveLength(2);
    expect(storePaths).toContain(MAIN_STORE_PATH);
    expect(storePaths).toContain(MYBOT_STORE_PATH);
  });
});

describe("resolveSession", () => {
  const MAIN_STORE_PATH = "/tmp/main-store.json";
  const cfg: OpenClawConfig = {
    session: { scope: "per-sender", mainKey: "main" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAgentIds.mockReturnValue(["main"]);
    mocks.resolveStorePath.mockReturnValue(MAIN_STORE_PATH);
  });

  it("reuses sessionId for named agent sessions even when reset policy marks them stale (#14459)", async () => {
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:sip-v3": {
        sessionId: "544c1a32-da1b-43c0-a4de-e3fb5a1cffb4",
        updatedAt: 0,
      },
    });

    const result = resolveSession({
      cfg,
      sessionKey: "agent:main:sip-v3",
    });

    expect(result.sessionId).toBe("544c1a32-da1b-43c0-a4de-e3fb5a1cffb4");
    expect(result.isNewSession).toBe(false);
  });

  it("still applies reset policy to the agent main session", async () => {
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:main": {
        sessionId: "00000000-0000-4000-8000-000000000000",
        updatedAt: 0,
      },
    });

    const result = resolveSession({
      cfg,
      sessionKey: "agent:main:main",
    });

    expect(result.sessionId).not.toBe("00000000-0000-4000-8000-000000000000");
    expect(result.isNewSession).toBe(true);
  });
});
