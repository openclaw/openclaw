import { vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createEmbeddedRunHandle } from "../agents/embedded-agent-runner/runs.test-support.js";
import { resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  closeDiagnosticEmbeddedRunOwner,
  createDiagnosticEmbeddedRunOwner,
} from "./diagnostic-run-activity.js";
import type {
  StuckSessionRecoveryOutcome,
  StuckSessionRecoveryRequest,
} from "./diagnostic-session-recovery.js";
import { recoverStuckDiagnosticSession } from "./diagnostic-stuck-session-recovery.runtime.js";
import { startGatewayDiagnosticHeartbeat } from "./diagnostic.js";
import { resetDiagnosticStateForTest } from "./diagnostic.test-support.js";

export function resetDiagnosticRecoveryState() {
  resetDiagnosticStateForTest();
  resetDiagnosticEventsForTest();
}

export function recoverQueuedReply(
  sessionId: string,
  sessionKey: string,
  overrides: Partial<Parameters<typeof recoverStuckDiagnosticSession>[0]> = {},
) {
  return recoverStuckDiagnosticSession({
    sessionId,
    sessionKey,
    ageMs: 720_000,
    queueDepth: 1,
    allowActiveAbort: true,
    ...overrides,
  });
}

export const diagnosticTimerTypes = [
  "Date",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
] as const;

export function createQueuedRecoveryHeartbeat() {
  const classified = createDeferred<StuckSessionRecoveryRequest>();
  const dispatch = createDeferred();
  const recovered = createDeferred<StuckSessionRecoveryOutcome>();
  const outcomes: StuckSessionRecoveryOutcome[] = [];
  const recover = vi.fn(async (request: StuckSessionRecoveryRequest) => {
    classified.resolve(request);
    await dispatch.promise;
    const outcome = await recoverStuckDiagnosticSession(request);
    outcomes.push(outcome);
    recovered.resolve(outcome);
    return outcome;
  });
  const start = () =>
    startGatewayDiagnosticHeartbeat(
      createTestGatewayScheduler("fake-timers"),
      { diagnostics: { enabled: true } },
      { sampleLiveness: () => null, recoverStuckSession: recover },
    );
  return { classified, dispatch, recovered, outcomes, recover, start };
}

export function createDiagnosticRunHandle(
  ref: Parameters<typeof createDiagnosticEmbeddedRunOwner>[0],
  abort = vi.fn<() => void>(),
) {
  const owner = createDiagnosticEmbeddedRunOwner(ref);
  return {
    ...createEmbeddedRunHandle({ runId: ref.runId, abort }),
    diagnosticOwner: owner,
    closeDiagnostics: () => closeDiagnosticEmbeddedRunOwner(owner),
    abort,
  };
}
