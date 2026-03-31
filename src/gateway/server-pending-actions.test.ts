import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
  updateSessionStore: vi.fn(async (_path: string, fn: (store: Record<string, unknown>) => void) => {
    // Execute the updater so we can verify delete behavior
    const store: Record<string, { pendingAction?: unknown }> = {
      "agent:main:main": { pendingAction: { type: "reset", scheduledAt: Date.now() } },
    };
    fn(store);
    return store;
  }),
  resolveSessionFilePath: vi.fn(() => "/sessions/s1.jsonl"),
  resolveSessionFilePathOptions: vi.fn(() => ({})),
  resolveAgentIdFromSessionKey: vi.fn(() => "main"),
  resolveAgentWorkspaceDir: vi.fn(() => "/workspace"),
  resolveDefaultAgentId: vi.fn(() => "main"),
  compactEmbeddedPiSession: vi.fn(async () => ({
    ok: true,
    compacted: true,
    result: { tokensBefore: 50000, tokensAfter: 5000 },
  })),
  performGatewaySessionReset: vi.fn(async () => ({
    ok: true,
    key: "agent:main:main",
    entry: {},
  })),
  loadCombinedSessionStoreForGateway: vi.fn(() => ({ store: {} })),
  resolveGatewaySessionStoreTarget: vi.fn((params: { key: string }) => ({
    storePath: "/sessions/store.json",
    storeKeys: [params.key],
  })),
}));

vi.mock("../config/config.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../config/sessions.js", () => ({ updateSessionStore: mocks.updateSessionStore }));
vi.mock("../config/sessions/paths.js", () => ({
  resolveSessionFilePath: mocks.resolveSessionFilePath,
  resolveSessionFilePathOptions: mocks.resolveSessionFilePathOptions,
}));
vi.mock("../routing/session-key.js", () => ({
  resolveAgentIdFromSessionKey: mocks.resolveAgentIdFromSessionKey,
}));
vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
}));
vi.mock("../agents/pi-embedded-runner/compact.js", () => ({
  compactEmbeddedPiSession: mocks.compactEmbeddedPiSession,
}));
vi.mock("./session-reset-service.js", () => ({
  performGatewaySessionReset: mocks.performGatewaySessionReset,
}));
vi.mock("./session-utils.js", () => ({
  loadCombinedSessionStoreForGateway: mocks.loadCombinedSessionStoreForGateway,
  resolveGatewaySessionStoreTarget: mocks.resolveGatewaySessionStoreTarget,
}));

import { recoverPendingActions } from "./server-pending-actions.js";

function createLog() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe("recoverPendingActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default implementations after clearAllMocks
    mocks.loadConfig.mockReturnValue({});
    mocks.updateSessionStore.mockImplementation(
      async (_path: string, fn: (s: Record<string, unknown>) => void) => {
        const store: Record<string, { pendingAction?: unknown }> = {};
        fn(store);
        return store;
      },
    );
    mocks.resolveSessionFilePath.mockReturnValue("/sessions/s1.jsonl");
    mocks.resolveSessionFilePathOptions.mockReturnValue({});
    mocks.resolveAgentIdFromSessionKey.mockReturnValue("main");
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/workspace");
    mocks.resolveDefaultAgentId.mockReturnValue("main");
    mocks.compactEmbeddedPiSession.mockResolvedValue({
      ok: true,
      compacted: true,
      result: { tokensBefore: 50000, tokensAfter: 5000 },
    });
    mocks.performGatewaySessionReset.mockResolvedValue({
      ok: true,
      key: "agent:main:main",
      entry: {},
    });
    mocks.resolveGatewaySessionStoreTarget.mockImplementation((params: { key: string }) => ({
      storePath: "/sessions/store.json",
      storeKeys: [params.key],
    }));
  });

  it("does nothing when no sessions have pendingAction", async () => {
    mocks.loadCombinedSessionStoreForGateway.mockReturnValue({
      store: {
        "agent:main:main": { sessionId: "s1" },
        "agent:einstein:main": { sessionId: "s2" },
      },
    });
    const log = createLog();
    await recoverPendingActions({ log, gatewayBootMs: Date.now() });

    expect(mocks.performGatewaySessionReset).not.toHaveBeenCalled();
    expect(mocks.compactEmbeddedPiSession).not.toHaveBeenCalled();
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it("recovers a recent reset action", async () => {
    mocks.loadCombinedSessionStoreForGateway.mockReturnValue({
      store: {
        "agent:main:main": {
          sessionId: "s1",
          pendingAction: { type: "reset", scheduledAt: Date.now() - 60_000 },
        },
      },
    });
    const log = createLog();
    await recoverPendingActions({ log, gatewayBootMs: Date.now() });

    expect(mocks.performGatewaySessionReset).toHaveBeenCalledWith({
      key: "agent:main:main",
      reason: "reset",
      commandSource: "gateway:pending-action-recovery",
    });
    expect(mocks.updateSessionStore).toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("recovering reset action on agent:main:main"),
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("1 found, 1 recovered, 0 cleared"),
    );
  });

  it("recovers a recent compact action with instructions", async () => {
    mocks.loadCombinedSessionStoreForGateway.mockReturnValue({
      store: {
        "agent:einstein:main": {
          sessionId: "s2",
          pendingAction: {
            type: "compact",
            scheduledAt: Date.now() - 120_000,
            instructions: "Focus on research context",
          },
        },
      },
    });
    const log = createLog();
    await recoverPendingActions({ log, gatewayBootMs: Date.now() });

    expect(mocks.compactEmbeddedPiSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s2",
        sessionKey: "agent:einstein:main",
        trigger: "manual",
        customInstructions: "Focus on research context",
        allowGatewaySubagentBinding: true,
      }),
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("1 found, 1 recovered, 0 cleared"),
    );
  });

  it("counts ok:true compacted:false as recovered (no-op compaction is still success)", async () => {
    mocks.loadCombinedSessionStoreForGateway.mockReturnValue({
      store: {
        "agent:einstein:main": {
          sessionId: "s2",
          pendingAction: {
            type: "compact",
            scheduledAt: Date.now() - 30_000,
          },
        },
      },
    });
    mocks.compactEmbeddedPiSession.mockResolvedValue({
      ok: true,
      compacted: false,
    } as never);
    const log = createLog();
    await recoverPendingActions({ log, gatewayBootMs: Date.now() });

    expect(mocks.compactEmbeddedPiSession).toHaveBeenCalledTimes(1);
    // ok:true means operation completed — counts as recovered, marker cleared
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("1 found, 1 recovered, 0 cleared"),
    );
    expect(mocks.updateSessionStore).toHaveBeenCalled();
  });

  it("skips actions scheduled after process start (live deferred waiters)", async () => {
    mocks.loadCombinedSessionStoreForGateway.mockReturnValue({
      store: {
        "agent:main:main": {
          sessionId: "s1",
          pendingAction: { type: "reset", scheduledAt: Date.now() + 1000 },
        },
      },
    });
    const log = createLog();
    await recoverPendingActions({ log, gatewayBootMs: Date.now() });

    expect(mocks.performGatewaySessionReset).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("skipping reset action on agent:main:main"),
    );
  });

  it("clears stale actions without executing them", async () => {
    const staleTime = Date.now() - 7 * 60 * 60 * 1000; // 7 hours ago (> MAX_AGE_MS of 6h)
    mocks.loadCombinedSessionStoreForGateway.mockReturnValue({
      store: {
        "agent:main:main": {
          sessionId: "s1",
          pendingAction: { type: "compact", scheduledAt: staleTime },
        },
      },
    });
    const log = createLog();
    await recoverPendingActions({ log, gatewayBootMs: Date.now() });

    expect(mocks.compactEmbeddedPiSession).not.toHaveBeenCalled();
    expect(mocks.performGatewaySessionReset).not.toHaveBeenCalled();
    expect(mocks.updateSessionStore).toHaveBeenCalled(); // called to clear it
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("clearing stale compact action"));
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("1 found, 0 recovered, 1 cleared"),
    );
  });

  it("leaves pendingAction in place when recovery throws", async () => {
    mocks.loadCombinedSessionStoreForGateway.mockReturnValue({
      store: {
        "agent:main:main": {
          sessionId: "s1",
          pendingAction: { type: "reset", scheduledAt: Date.now() - 120_000 },
        },
      },
    });
    mocks.performGatewaySessionReset.mockRejectedValue(new Error("session locked"));
    const log = createLog();
    await recoverPendingActions({ log, gatewayBootMs: Date.now() });

    // Reset failed — pendingAction stays for next restart
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to recover reset on agent:main:main: Error: session locked"),
    );
  });

  it("does not count reset as recovered when performGatewaySessionReset returns ok:false", async () => {
    mocks.loadCombinedSessionStoreForGateway.mockReturnValue({
      store: {
        "agent:main:main": {
          sessionId: "s1",
          pendingAction: { type: "reset", scheduledAt: Date.now() - 120_000 },
        },
      },
    });
    mocks.performGatewaySessionReset.mockResolvedValue({
      ok: false,
      error: { code: "UNAVAILABLE", message: "Session still active" },
    } as never);
    const log = createLog();
    await recoverPendingActions({ log, gatewayBootMs: Date.now() });

    expect(mocks.performGatewaySessionReset).toHaveBeenCalledTimes(1);
    // Should NOT count as recovered
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("1 found, 0 recovered, 0 cleared"),
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("reset returned error for agent:main:main: Session still active"),
    );
    // pendingAction stays — only cleared on success
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
  });

  it("handles multiple sessions with mixed pending states", async () => {
    mocks.loadCombinedSessionStoreForGateway.mockReturnValue({
      store: {
        "agent:main:main": {
          sessionId: "s1",
          pendingAction: { type: "reset", scheduledAt: Date.now() - 10_000 },
        },
        "agent:einstein:main": {
          sessionId: "s2",
          // no pendingAction — should be skipped
        },
        "agent:main:discord:direct:123": {
          sessionId: "s3",
          pendingAction: {
            type: "compact",
            scheduledAt: Date.now() - 7 * 60 * 60 * 1000, // 7 hours — stale (> MAX_AGE_MS of 6h)
          },
        },
      },
    });
    const log = createLog();
    await recoverPendingActions({ log, gatewayBootMs: Date.now() });

    expect(mocks.performGatewaySessionReset).toHaveBeenCalledTimes(1);
    expect(mocks.compactEmbeddedPiSession).not.toHaveBeenCalled(); // stale compact not executed
    // Summary line: 2 found (reset + stale compact), 1 recovered (reset), 1 cleared (stale compact)
    const summaryCall = log.info.mock.calls.find(
      (c: string[]) => typeof c[0] === "string" && c[0].includes("found"),
    );
    expect(summaryCall).toBeDefined();
    expect(summaryCall![0]).toContain("2 found");
    expect(summaryCall![0]).toContain("1 recovered");
    expect(summaryCall![0]).toContain("1 cleared");
  });

  it("survives total scan failure gracefully", async () => {
    mocks.loadCombinedSessionStoreForGateway.mockImplementation(() => {
      throw new Error("corrupt store");
    });
    const log = createLog();
    await recoverPendingActions({ log, gatewayBootMs: Date.now() });

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("recovery scan failed: Error: corrupt store"),
    );
  });
});
