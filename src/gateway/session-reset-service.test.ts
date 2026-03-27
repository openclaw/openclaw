import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clearSessionQueues: vi.fn<
    (
      keys: string[],
      options?: unknown,
    ) => {
      followupCleared: number;
      laneCleared: number;
      keys: string[];
    }
  >(() => ({ followupCleared: 0, laneCleared: 0, keys: [] })),
  resumeFollowupDrain: vi.fn<(key: string) => void>(),
  stopSubagentsForRequester: vi.fn<(params: unknown) => void>(),
  waitForEmbeddedPiRunEnd: vi.fn<(sessionId: string, timeoutMs: number) => Promise<boolean>>(),
  abortEmbeddedPiRun: vi.fn<(sessionId: string) => void>(),
  clearBootstrapSnapshot: vi.fn<(sessionKey: string) => void>(),
  triggerInternalHook: vi.fn<(event: unknown) => Promise<void>>(async () => {}),
  createInternalHookEvent: vi.fn<
    (type: string, action: string, sessionKey: string, context: unknown) => { type: string }
  >(() => ({ type: "command" })),
  closeTrackedBrowserTabsForSessions: vi.fn<(params: unknown) => Promise<number>>(async () => 0),
  updateSessionStore: vi.fn<(storePath: string, updater: unknown) => unknown>(),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({}),
}));

vi.mock("../config/sessions.js", () => ({
  snapshotSessionOrigin: vi.fn(() => undefined),
  updateSessionStore: (storePath: string, updater: unknown) =>
    mocks.updateSessionStore(storePath, updater),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: () => "main",
}));

vi.mock("../agents/bootstrap-cache.js", () => ({
  clearBootstrapSnapshot: (sessionKey: string) => mocks.clearBootstrapSnapshot(sessionKey),
}));

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: (sessionId: string) => mocks.abortEmbeddedPiRun(sessionId),
  waitForEmbeddedPiRunEnd: (sessionId: string, timeoutMs: number) =>
    mocks.waitForEmbeddedPiRunEnd(sessionId, timeoutMs),
}));

vi.mock("../auto-reply/reply/abort.js", () => ({
  stopSubagentsForRequester: (params: unknown) => mocks.stopSubagentsForRequester(params),
}));

vi.mock("../auto-reply/reply/queue.js", () => ({
  clearSessionQueues: (keys: string[], options?: unknown) =>
    mocks.clearSessionQueues(keys, options),
  resumeFollowupDrain: (key: string) => mocks.resumeFollowupDrain(key),
}));

vi.mock("../browser/session-tab-registry.js", () => ({
  closeTrackedBrowserTabsForSessions: (params: unknown) =>
    mocks.closeTrackedBrowserTabsForSessions(params),
}));

vi.mock("../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: (...args: [string, string, string, unknown]) =>
    mocks.createInternalHookEvent(...args),
  triggerInternalHook: (event: unknown) => mocks.triggerInternalHook(event),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => undefined,
}));

vi.mock("../plugins/runtime/index.js", () => ({
  createPluginRuntime: () => ({
    channel: {
      discord: {
        threadBindings: {
          unbindBySessionKey: vi.fn(),
        },
      },
    },
  }),
}));

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    cancelSession: vi.fn(async () => {}),
    closeSession: vi.fn(async () => {}),
  }),
}));

vi.mock("./session-utils.js", () => ({
  archiveSessionTranscripts: vi.fn(() => []),
  loadSessionEntry: () => ({
    entry: {
      sessionId: "sess-main",
      updatedAt: 1,
    },
    legacyKey: undefined,
    canonicalKey: "agent:main:main",
  }),
  migrateAndPruneGatewaySessionStoreKey: vi.fn(() => ({ primaryKey: "main" })),
  resolveGatewaySessionStoreTarget: () => ({
    storePath: "/tmp/sessions.json",
    canonicalKey: "agent:main:main",
    storeKeys: ["main"],
    agentId: undefined,
  }),
  resolveSessionModelRef: vi.fn(() => ({ provider: "openai", model: "gpt-5.4" })),
}));

vi.mock("../routing/session-key.js", () => ({
  isSubagentSessionKey: () => false,
  normalizeAgentId: (value: string) => value,
  parseAgentSessionKey: vi.fn(() => undefined),
}));

import { performGatewaySessionReset } from "./session-reset-service.js";

describe("performGatewaySessionReset", () => {
  beforeEach(() => {
    mocks.clearSessionQueues.mockClear();
    mocks.resumeFollowupDrain.mockClear();
    mocks.stopSubagentsForRequester.mockClear();
    mocks.waitForEmbeddedPiRunEnd.mockReset();
    mocks.abortEmbeddedPiRun.mockClear();
    mocks.clearBootstrapSnapshot.mockClear();
    mocks.triggerInternalHook.mockClear();
    mocks.createInternalHookEvent.mockClear();
    mocks.closeTrackedBrowserTabsForSessions.mockClear();
    mocks.updateSessionStore.mockClear();
  });

  it("resumes preserved followups when reset cleanup returns unavailable", async () => {
    mocks.waitForEmbeddedPiRunEnd.mockResolvedValue(false);

    const result = await performGatewaySessionReset({
      key: "main",
      reason: "reset",
      commandSource: "gateway:sessions.reset",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected reset to fail");
    }
    expect(result.error.code).toBe("UNAVAILABLE");
    expect(mocks.clearSessionQueues).toHaveBeenCalledWith(
      ["main", "agent:main:main", "sess-main"],
      {
        clearFollowups: false,
        clearDrainCallbacks: false,
        clearLanes: true,
        pauseFollowups: true,
      },
    );
    expect(mocks.resumeFollowupDrain).toHaveBeenCalledTimes(3);
    expect(mocks.resumeFollowupDrain).toHaveBeenCalledWith("main");
    expect(mocks.resumeFollowupDrain).toHaveBeenCalledWith("agent:main:main");
    expect(mocks.resumeFollowupDrain).toHaveBeenCalledWith("sess-main");
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
  });
});
