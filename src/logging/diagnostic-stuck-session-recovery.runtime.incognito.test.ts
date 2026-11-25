import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import * as placement from "../agents/session-placement-admission.js";
import { setDiagnosticsEnabledForProcess } from "../infra/diagnostic-events.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { getSessionControllerOperation } from "../sessions/session-controller.state.js";
import { testing } from "../sessions/session-controller.test-support.js";
import { diagnosticLogger } from "./diagnostic-runtime.js";
import {
  getDiagnosticSessionState,
  pruneDiagnosticSessionStates,
  resetDiagnosticSessionStateForTest,
  resolveDiagnosticSessionKey,
  retireDiagnosticSessionObservations,
} from "./diagnostic-session-state.js";
import { recoverStuckDiagnosticSession } from "./diagnostic-stuck-session-recovery.runtime.js";

const warn = vi.fn<typeof diagnosticLogger.warn>();
const ageMs = 720_000;
function failure(marker: string) {
  return { status: "failed", action: "none", reason: "exception", error: `Error: ${marker}` };
}

function begin(incognito: boolean, suffix = "recovery") {
  const sessionId = `${incognito ? "private" : "ordinary"}-${suffix}-id`;
  const sessionKey = `agent:main:dashboard:${incognito ? "incognito-" : ""}${suffix}`;
  const marker = incognito ? "SYNTHETIC_PRIVATE_FAILURE" : "SYNTHETIC_ORDINARY_FAILURE";
  const state = getDiagnosticSessionState({ sessionId, sessionKey });
  state.state = "processing";
  const operation = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
  operation.setPhase("running");
  const cancel = vi.fn(() => operation.complete());
  operation.attachBackend({ kind: "embedded", cancel });
  const request = { operation, stateGeneration: state.generation ?? 0, ageMs, queueDepth: 1 };
  return { sessionId, sessionKey, marker, request, operation, cancel };
}

function expectRecoveryLogs(incognito: boolean, sessionId: string, marker?: string) {
  if (incognito) {
    expect(warn).not.toHaveBeenCalled();
  } else {
    const output = warn.mock.calls.map(([message]) => message).join("\n");
    expect(output).toContain(sessionId);
    if (marker) {
      expect(output).toContain(marker);
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  resetDiagnosticSessionStateForTest();
  setDiagnosticsEnabledForProcess(true);
  warn.mockClear();
  vi.spyOn(diagnosticLogger, "warn").mockImplementation(warn);
});

afterEach(() => {
  testing.resetSessionControllerForTest();
  setDiagnosticsEnabledForProcess(false);
  resetDiagnosticSessionStateForTest();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.each([true, false])("controller recovery with Incognito=%s", (incognito) => {
  describe.each(["key", "session-id"] as const)("identified by %s", (identity) => {
    it.each(["returned-failure", "internal-exception", "observe", "abort"] as const)(
      "preserves %s outcomes and actions without private formatted output",
      async (scenario) => {
        const { sessionId, sessionKey, marker, request, operation, cancel } = begin(incognito);
        const ref = identity === "key" ? { sessionId, sessionKey } : { sessionId };
        const recoverTerminalTurn = vi
          .spyOn(placement, "recoverTerminalSessionPlacementTurn")
          .mockResolvedValue(undefined);
        if (scenario === "returned-failure") {
          recoverTerminalTurn.mockResolvedValue(marker);
        } else if (scenario === "internal-exception") {
          operation.watchdog.beginExecution(() => {
            throw new Error(marker);
          });
        } else if (scenario === "observe") {
          operation.watchdog.beginWait({ kind: "human_question", isCurrent: () => true });
        }
        vi.setSystemTime(ageMs);

        const outcome = await recoverStuckDiagnosticSession({ ...request, ...ref });

        expect(outcome).toMatchObject(ref);
        expect(outcome.sessionKey).toBe(identity === "key" ? sessionKey : undefined);
        if (scenario === "returned-failure" || scenario === "internal-exception") {
          expect(outcome).toMatchObject(failure(marker));
        } else if (scenario === "observe") {
          expect(outcome).toMatchObject({
            status: "skipped",
            action: "observe_only",
            reason: "active_reply_work",
          });
        } else {
          expect(outcome).toMatchObject({
            status: "aborted",
            action: "abort_embedded_run",
            aborted: true,
            drained: true,
            forceCleared: false,
            released: 0,
          });
          expect(operation.result).toMatchObject({ kind: "failed", code: "run_stalled" });
        }
        expect(cancel).toHaveBeenCalledTimes(scenario === "abort" ? 1 : 0);
        expect(getSessionControllerOperation(sessionKey)).toBe(
          scenario === "abort" ? undefined : operation,
        );
        expectRecoveryLogs(
          incognito,
          sessionId,
          scenario === "returned-failure" || scenario === "internal-exception" ? marker : undefined,
        );
      },
    );
  });

  it.for([
    { retirement: "before-recovery", scenario: "returned-failure" },
    { retirement: "before-recovery", scenario: "rejected-placement" },
    { retirement: "during-placement", scenario: "returned-failure" },
    { retirement: "during-placement", scenario: "rejected-placement" },
  ] as const)(
    "preserves ID-only privacy and $scenario outcomes with retirement $retirement",
    async ({ retirement, scenario }, { signal }) => {
      const { sessionId, sessionKey, marker, request, operation, cancel } = begin(
        incognito,
        "retired",
      );
      const placementStarted = createDeferred();
      const terminalTurn = createDeferred<string | undefined>();
      vi.spyOn(placement, "recoverTerminalSessionPlacementTurn").mockImplementationOnce(() => {
        placementStarted.resolve();
        return terminalTurn.promise;
      });
      vi.setSystemTime(ageMs);
      if (retirement === "before-recovery") {
        retireDiagnosticSessionObservations();
        pruneDiagnosticSessionStates(Date.now() + 31 * 60_000, true);
        expect(resolveDiagnosticSessionKey({ sessionId })).toBeUndefined();
      }
      const recovery = recoverStuckDiagnosticSession({ ...request, sessionId });

      try {
        await withinTest(
          awaitGateBeforeSettlement(
            placementStarted.promise,
            recovery,
            "recovery completed before placement lookup",
          ),
          signal,
        );
        if (retirement === "during-placement") {
          retireDiagnosticSessionObservations();
          pruneDiagnosticSessionStates(Date.now() + 31 * 60_000, true);
        }
        expect(resolveDiagnosticSessionKey({ sessionId })).toBeUndefined();
        if (scenario === "returned-failure") {
          terminalTurn.resolve(marker);
        } else {
          terminalTurn.reject(new Error(marker));
        }
        const outcome = await withinTest(recovery, signal);

        expectRecoveryLogs(incognito, sessionId, marker);
        expect(outcome).toEqual({
          ...failure(marker),
          sessionId,
          sessionKey: undefined,
        });
        expect(cancel).not.toHaveBeenCalled();
        expect(getSessionControllerOperation(sessionKey)).toBe(operation);
        expect(resolveDiagnosticSessionKey({ sessionId })).toBeUndefined();
      } finally {
        terminalTurn.resolve(undefined);
        await recovery;
      }
    },
  );
});
