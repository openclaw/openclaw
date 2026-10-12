import { expect, it, vi } from "vitest";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";

const persistenceMocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  updateSessionEntry: vi.fn(),
}));
const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

// Lifecycle projection formats stored failures without initializing provider runtime.
vi.mock("../plugins/loader-runtime-load.js", () => {
  throw new Error("Session lifecycle presentation imported plugin runtime ownership");
});

// mock-isolation: Exercise recovery reducers without native persistence or transcript writes.
vi.mock("../config/sessions/session-accessor.js", () => ({
  patchSessionEntryTarget: persistenceMocks.updateSessionEntry,
  appendSessionTranscriptReport: vi.fn(async () => ({ ok: true, value: undefined })),
}));

// mock-isolation: Controlled entries isolate recovery projection from database admission.
vi.mock("./session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: async (...args: unknown[]) =>
    persistenceMocks.loadSessionEntry(...args),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => loggerMocks,
}));

import {
  persistLifecycleThroughMockedStore,
  type LifecycleEvent,
} from "./session-lifecycle-state.test-support.js";

function persistLifecycle(
  entry: Omit<SessionEntry, "sessionId" | "updatedAt">,
  event: Omit<LifecycleEvent, "sessionId" | "ts">,
): Promise<SessionEntry> {
  return persistLifecycleThroughMockedStore(persistenceMocks, {
    sessionKey: "agent:main:main",
    entry: { sessionId: "session-id", updatedAt: 1_000, ...entry },
    event: { sessionId: "session-id", ts: 2_000, ...event },
  });
}

const recovery = { cycleId: "cycle-1", revision: 2, chargedAttempts: 2 };
const interrupted = { runId: "interrupted-run", lifecycleGeneration: "pre-restart" };
const foregroundClaims = (lifecycleGeneration: string) => ({
  lifecycleGeneration,
  tokens: ["owner-claim"],
  runIdsByClaimId: { "owner-claim": "foreground-run" },
});
type RecoveryCase = {
  name: string;
  input: (generation: string) => {
    entry: Partial<SessionEntry>;
    event: Omit<LifecycleEvent, "sessionId" | "ts">;
  };
  expected: Partial<SessionEntry>;
  clearsRecovery?: boolean;
  clearsOwner?: boolean;
  warning?: string;
};
const cases: RecoveryCase[] = [
  {
    name: "preserves recovery state for a late interrupted-run event",
    input: () => ({
      entry: {
        restartRecoveryRuns: [{ runId: "restart-run", lifecycleGeneration: "pre-restart" }],
      },
      event: {
        runId: "restart-run",
        lifecycleGeneration: "pre-restart",
        data: { phase: "end", aborted: true, stopReason: "restart" },
      },
    }),
    expected: {
      status: "interrupted",
      abortedLastRun: true,
      restartRecoveryRuns: [{ runId: "restart-run", lifecycleGeneration: "pre-restart" }],
      mainRestartRecovery: recovery,
    },
  },
  {
    name: "settles a hard timeout even when shutdown already marked the run for recovery",
    input: (lifecycleGeneration) => ({
      entry: {
        startedAt: 1_000,
        lifecycleRunId: "timed-out-run",
        restartRecoveryRuns: [{ runId: "timed-out-run", lifecycleGeneration }],
      },
      event: {
        runId: "timed-out-run",
        lifecycleGeneration,
        data: {
          phase: "error",
          aborted: true,
          stopReason: "restart",
          timeoutPhase: "provider",
          providerStarted: true,
          endedAt: 2_000,
        },
      },
    }),
    expected: { status: "timeout", abortedLastRun: false, endedAt: 2_000 },
    clearsRecovery: true,
  },
  {
    name: "ignores an unidentified completion while recovery remains pending",
    input: () => ({
      entry: {
        startedAt: 1_050,
        lifecycleRunId: "foreground-run",
        restartRecoveryRuns: [{ runId: "restart-run", lifecycleGeneration: "pre-restart" }],
      },
      event: { data: { phase: "end", endedAt: 1_800 } },
    }),
    expected: {
      status: "interrupted",
      abortedLastRun: true,
      restartRecoveryRuns: [{ runId: "restart-run", lifecycleGeneration: "pre-restart" }],
      mainRestartRecovery: recovery,
    },
  },
  {
    name: "applies the terminal snapshot for the foreground owner run",
    input: (lifecycleGeneration) => ({
      entry: {
        startedAt: 1_050,
        restartRecoveryRuns: [interrupted, { runId: "foreground-run", lifecycleGeneration }],
        mainRestartRecovery: {
          ...recovery,
          foregroundClaims: foregroundClaims(lifecycleGeneration),
        },
      },
      event: {
        runId: "foreground-run",
        lifecycleGeneration,
        data: { phase: "end", endedAt: 1_800 },
      },
    }),
    expected: { status: "done", endedAt: 1_800, abortedLastRun: false },
    clearsRecovery: true,
    clearsOwner: true,
  },
  {
    name: "reports an exact recovery run's terminal outcome after persistence",
    input: (lifecycleGeneration) => ({
      entry: {
        startedAt: 1_050,
        lifecycleRunId: "recovery-run",
        abortedLastRun: false,
        restartRecoveryDeliveryRunId: "recovery-run",
        restartRecoveryRuns: [
          { runId: "recovery-run", lifecycleGeneration: "pre-restart" },
          { runId: "recovery-run", lifecycleGeneration },
        ],
        mainRestartRecovery: { ...recovery, revision: 5 },
      },
      event: {
        runId: "recovery-run",
        lifecycleGeneration,
        mainSessionRestartRecovery: true,
        data: { phase: "error", endedAt: 1_800, error: "provider failed" },
      },
    }),
    expected: { status: "failed" },
    clearsRecovery: true,
    warning:
      "main-session restart recovery terminal: session=agent:main:main run=recovery-run status=error reason=failed",
  },
  {
    name: "does not settle a foreground owner from a stale lifecycle generation",
    input: () => ({
      entry: {
        startedAt: 1_050,
        lifecycleRunId: "foreground-run",
        restartRecoveryRuns: [
          interrupted,
          { runId: "foreground-run", lifecycleGeneration: "pre-restart" },
        ],
        mainRestartRecovery: { ...recovery, foregroundClaims: foregroundClaims("pre-restart") },
      },
      event: {
        runId: "foreground-run",
        lifecycleGeneration: "pre-restart",
        data: { phase: "end", endedAt: 1_800 },
      },
    }),
    expected: {
      status: "interrupted",
      abortedLastRun: true,
      lifecycleRunId: "foreground-run",
      restartRecoveryRuns: [interrupted],
      mainRestartRecovery: { ...recovery, foregroundClaims: foregroundClaims("pre-restart") },
    },
  },
];

it.each(cases)("$name", async ({ input, expected, clearsRecovery, clearsOwner, warning }) => {
  const { entry, event } = input(getAgentEventLifecycleGeneration());
  loggerMocks.warn.mockClear();
  const persisted = await persistLifecycle(
    { status: "interrupted", abortedLastRun: true, mainRestartRecovery: recovery, ...entry },
    event,
  );
  expect(persisted).toMatchObject(expected);
  if (expected.restartRecoveryRuns) {
    expect(persisted.restartRecoveryRuns).toEqual(expected.restartRecoveryRuns);
  }
  if (clearsRecovery) {
    expect(persisted.restartRecoveryRuns).toBeUndefined();
    expect(persisted.mainRestartRecovery).toBeUndefined();
  }
  if (clearsOwner) {
    expect(persisted.lifecycleRunId).toBeUndefined();
  }
  if (warning) {
    expect(loggerMocks.warn).toHaveBeenCalledWith(warning);
  }
});
