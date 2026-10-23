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
beforeEach(() => {
  diagnosticsEnabled = areDiagnosticsEnabledForProcess();
  setDiagnosticsEnabledForProcess(true);
});
afterEach(() => {
  testing.resetSessionControllerForTest();
  resetDiagnosticSessionStateForTest();
  setDiagnosticsEnabledForProcess(diagnosticsEnabled);
});

it("retires the source's processing state when a queued operation moves to an existing destination", () => {
  const source = { sessionKey: "agent:main:source", sessionId: "source-session" };
  const destination = { sessionKey: "agent:main:destination", sessionId: "destination-session" };
  const operation = createReplyOperation({ ...source, resetTriggered: false });
  logSessionStateChange({ ...source, state: "processing" });
  logSessionStateChange({ ...destination, state: "idle" });

  operation.updateSessionKey(destination.sessionKey);
  expect(peekDiagnosticSessionState({ sessionKey: source.sessionKey })).toBeUndefined();
  expect(peekDiagnosticSessionState({ sessionKey: destination.sessionKey })?.state).toBe(
    "processing",
  );
  operation.complete();

  expect(peekDiagnosticSessionState({ sessionKey: source.sessionKey })).toBeUndefined();
  expect(peekDiagnosticSessionState({ sessionKey: destination.sessionKey })?.state).toBe("idle");
});

it("shows input waiting behind retained cleanup instead of resurrecting processing", async () => {
  const ref = { sessionKey: "agent:main:cleanup", sessionId: "cleanup-session" };
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
    const state = getDiagnosticSessionState(ref);
    await recoverStuckDiagnosticSession({
      ...ref,
      ageMs: 600_000,
      expectedState: "waiting",
      stateGeneration: state.generation,
      queueDepth: 1,
    });
    expect(getDiagnosticSessionState(ref)).toMatchObject({ state: "waiting", queueDepth: 1 });
  } finally {
    cleanup.resolve();
    await operation.ownerSettlement;
  }
});

it.each([0, 1])(
  "reconciles ownerless processing without discarding %i queued inputs",
  async (queued) => {
    const ref = { sessionKey: "agent:main:orphan", sessionId: "orphan-session" };
    if (queued) {
      logMessageQueuedWithBacklogPolicy({ ...ref, source: "dispatch" }, true);
    }
    logSessionStateChange({ ...ref, state: "processing" });
    const state = getDiagnosticSessionState(ref);
    await recoverStuckDiagnosticSession({
      ...ref,
      ageMs: 600_000,
      expectedState: "processing",
      stateGeneration: state.generation,
      queueDepth: queued,
    });
    expect(state).toMatchObject({ state: queued ? "waiting" : "idle", queueDepth: queued });
  },
);
