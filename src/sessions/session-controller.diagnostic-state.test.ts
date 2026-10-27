import { afterEach, beforeEach, expect, it } from "vitest";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../infra/diagnostic-events.js";
import {
  logMessageQueuedWithBacklogPolicy,
  logSessionStateChange,
} from "../logging/diagnostic-runtime.js";
import {
  getDiagnosticSessionState,
  peekDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "../logging/diagnostic-session-state.js";
import { recoverStuckDiagnosticSession } from "../logging/diagnostic-stuck-session-recovery.runtime.js";
import { createDiagnosticMessageLifecycle } from "../logging/message-lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createReplyOperation } from "./session-controller.operation.js";
import { testing } from "./session-controller.test-support.js";

let diagnosticsEnabled: boolean;
const ref = { sessionKey: "agent:main:source", sessionId: "source-session" };
beforeEach(() => {
  diagnosticsEnabled = areDiagnosticsEnabledForProcess();
  setDiagnosticsEnabledForProcess(true);
});
afterEach(() => {
  testing.resetSessionControllerForTest();
  resetDiagnosticSessionStateForTest();
  setDiagnosticsEnabledForProcess(diagnosticsEnabled);
});

function recover(expectedState: "waiting" | "processing", queueDepth: number) {
  return recoverStuckDiagnosticSession({
    ...ref,
    ageMs: 600_000,
    expectedState,
    stateGeneration: getDiagnosticSessionState(ref).generation,
    queueDepth,
  });
}

it("retires the source's processing state when a queued operation moves to an existing destination", () => {
  const dest = { sessionKey: "agent:main:destination", sessionId: "destination-session" };
  const operation = createReplyOperation({ ...ref, resetTriggered: false });
  logSessionStateChange({ ...ref, state: "processing" });
  logSessionStateChange({ ...dest, state: "idle" });

  operation.updateSessionKey(dest.sessionKey);
  expect(peekDiagnosticSessionState({ sessionKey: ref.sessionKey })).toBeUndefined();
  expect(peekDiagnosticSessionState({ sessionKey: dest.sessionKey })?.state).toBe("processing");
  operation.complete();

  expect(peekDiagnosticSessionState({ sessionKey: ref.sessionKey })).toBeUndefined();
  expect(peekDiagnosticSessionState({ sessionKey: dest.sessionKey })?.state).toBe("idle");
});

it("shows input waiting behind retained cleanup instead of resurrecting processing", async () => {
  const message = createDiagnosticMessageLifecycle({
    ...ref,
    enabled: true,
    channel: "test",
    source: "dispatch",
    trackSessionState: true,
  });
  message.markProcessing();
  const operation = createReplyOperation({ ...ref, resetTriggered: false });
  expect(getDiagnosticSessionState(ref).state).toBe("processing");
  message.markIdle();
  const cleanup = createDeferredCore();
  operation.completeWithAfterClearBarrier(cleanup.promise);
  try {
    message.markProcessing();
    expect(getDiagnosticSessionState(ref)).toMatchObject({ state: "waiting", queueDepth: 1 });
    await recover("waiting", 1);
    expect(getDiagnosticSessionState(ref)).toMatchObject({ state: "waiting", queueDepth: 1 });
  } finally {
    cleanup.resolve();
    await operation.ownerSettlement;
  }
});

it.each([0, 1])("reconciles ownerless processing with %i queued inputs", async (queued) => {
  if (queued) {
    logMessageQueuedWithBacklogPolicy({ ...ref, source: "dispatch" }, true);
  }
  logSessionStateChange({ ...ref, state: "processing" });
  const state = getDiagnosticSessionState(ref);
  await recover("processing", queued);
  expect(state).toMatchObject({ state: queued ? "waiting" : "idle", queueDepth: queued });
});
