import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { createMockGatewayRecoveryRuntime } from "./server-recovery-runtime.test-support.js";
import { recoverSessionSendDeliveries } from "./session-send-recovery.js";
import { config, delivery, input } from "./session-send-recovery.test-support.js";

const io = vi.hoisted(() => ({
  discover: vi.fn(),
  entries: vi.fn(),
  pending: vi.fn(),
  resumeMain: vi.fn(),
}));
vi.mock(
  import("../agents/main-session-recovery/main-session-restart-recovery-shared.js"),
  async (importOriginal) => ({
    ...(await importOriginal()),
    discoverRestartRecoveryStoreTargets: io.discover,
  }),
);
vi.mock(import("../config/sessions/session-entry-read-maintenance.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  readPendingInputRecoveryEntriesInWorker: io.entries,
}));
vi.mock(import("../config/sessions/session-pending-input-history.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  readSessionSendRecoveryPage: io.pending,
}));
vi.mock(
  import("../agents/main-session-recovery/main-session-restart-recovery.js"),
  async (importOriginal) => ({
    ...(await importOriginal()),
    retryRestartAbortedMainSessionRecovery: io.resumeMain,
  }),
);

beforeEach(() => {
  vi.resetAllMocks();
  setRuntimeConfigSnapshot(config);
  io.discover.mockResolvedValue([{ agentId: "main", storePath: "/fixture/sessions.json" }]);
  io.entries.mockResolvedValue([
    {
      sessionKey: delivery.target.sessionKey,
      entry: { sessionId: delivery.target.sessionId, updatedAt: 1, abortedLastRun: true },
    },
  ]);
  io.pending.mockResolvedValue({ items: [input], total: 1 });
  io.resumeMain.mockResolvedValue({ started: 0, settled: 0, failed: 0, skipped: 0 });
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
  resetGatewayWorkAdmission();
});

it.each(["shutdown", "restart"] as const)(
  "releases quarantined predecessor waiting on %s without starting either turn",
  async (outcome) => {
    const paused = createDeferred();
    const cancellation = new AbortController();
    const runtime = createMockGatewayRecoveryRuntime({
      prepareRestartRecovery: vi.fn(async () => {
        paused.resolve();
        return Date.now() + 60_000;
      }),
    });
    const context = createDirectChatContext({
      getRuntimeConfig: () => config,
      recoveryRuntime: runtime,
    });
    const recovery = recoverSessionSendDeliveries(context, cancellation.signal).settled;
    try {
      await awaitGateBeforeSettlement(
        paused.promise,
        recovery,
        "saved-input recovery finished without joining predecessor quarantine",
      );
      const rejected = expect(recovery).rejects.toThrow();
      if (outcome === "restart") {
        markGatewayRestartDraining();
      } else {
        cancellation.abort();
      }
      await rejected;
      expect(io.resumeMain).not.toHaveBeenCalled();
      expect(runtime.dispatchAgent).not.toHaveBeenCalled();
      expect(runtime.resumeChatInput).not.toHaveBeenCalled();
    } finally {
      cancellation.abort();
      await recovery.catch(() => {});
    }
  },
);
