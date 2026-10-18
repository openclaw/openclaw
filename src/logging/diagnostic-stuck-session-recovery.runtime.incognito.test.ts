// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  mocks,
  observeRecoveryContextLog,
  resetMocks,
  warnLogMessages,
} from "./diagnostic-stuck-session-recovery.runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import * as placement from "../agents/session-placement-admission.js";
import { setDiagnosticsEnabledForProcess } from "../infra/diagnostic-events.js";
import {
  getDiagnosticSessionState,
  peekDiagnosticSessionState,
  pruneDiagnosticSessionStates,
  resetDiagnosticSessionStateForTest,
  retireDiagnosticSessionObservations,
} from "./diagnostic-session-state.js";
import { recoverStuckDiagnosticSession } from "./diagnostic-stuck-session-recovery.runtime.js";

beforeEach(async () => {
  resetDiagnosticSessionStateForTest();
  setDiagnosticsEnabledForProcess(true);
  await resetMocks();
});

afterEach(() => {
  setDiagnosticsEnabledForProcess(false);
  resetDiagnosticSessionStateForTest();
  vi.restoreAllMocks();
});

describe.each(["key", "session-id"] as const)("Incognito recovery with %s", (identity) => {
  it.each([
    "returned-failure",
    "internal-exception",
    "release",
    "active-run",
    "reclaim-run",
    "reclaim-reply",
  ] as const)(
    "preserves %s outcomes and actions without private formatted output",
    async (scenario) => {
      for (const incognito of [true, false]) {
        await resetMocks();
        const sessionId = incognito ? "private-recovery-id" : "ordinary-recovery-id";
        const sessionKey = `agent:main:dashboard:${incognito ? "incognito-" : ""}recovery`;
        const state = getDiagnosticSessionState({ sessionId, sessionKey });
        state.state = "processing";
        const ref = identity === "key" ? { sessionId, sessionKey } : { sessionId };
        const marker = incognito ? "SYNTHETIC_PRIVATE_FAILURE" : "SYNTHETIC_ORDINARY_FAILURE";
        const recoverTerminalTurn = vi.spyOn(placement, "recoverTerminalSessionPlacementTurn");
        recoverTerminalTurn.mockResolvedValue(undefined);
        if (scenario === "returned-failure") {
          recoverTerminalTurn.mockResolvedValue(marker);
        } else if (scenario === "internal-exception") {
          mocks.getCommandLaneActiveTaskIds.mockImplementationOnce(() => {
            throw new Error(marker);
          });
        } else if (scenario === "active-run" || scenario === "reclaim-run") {
          mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(sessionId);
          mocks.isEmbeddedAgentRunHandleActive.mockReturnValue(true);
        } else if (scenario === "reclaim-reply") {
          mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue(sessionId);
          mocks.isEmbeddedAgentRunActive.mockReturnValue(true);
        }
        mocks.abortEmbeddedAgentRun.mockReturnValue(true);
        mocks.waitForEmbeddedAgentRunEnd.mockResolvedValue(true);
        mocks.resetCommandLane.mockReturnValue(1);

        const reclaimed = scenario === "reclaim-run" || scenario === "reclaim-reply";
        const contextLogged =
          !incognito && (reclaimed || scenario === "release")
            ? observeRecoveryContextLog(sessionId)
            : undefined;
        const outcome = await recoverStuckDiagnosticSession({
          ...ref,
          stateGeneration: state.generation ?? 0,
          ageMs: scenario === "active-run" ? 180_000 : 720_000,
          queueDepth: 1,
        });
        if (contextLogged) {
          await contextLogged;
        }
        expect(recoverTerminalTurn).toHaveBeenCalledWith(ref, expect.any(Function));
        expect(outcome).toMatchObject(ref);
        if (scenario === "returned-failure") {
          expect(outcome).toMatchObject({
            status: "failed",
            action: "fail_worker_turn",
            reason: "terminal_worker",
            error: marker,
          });
        } else if (scenario === "internal-exception") {
          expect(outcome).toMatchObject({
            status: "failed",
            action: "none",
            reason: "exception",
            error: `Error: ${marker}`,
          });
        } else if (scenario === "release") {
          expect(outcome).toMatchObject({
            status: "released",
            action: "release_lane",
            released: 1,
          });
        } else if (scenario === "active-run") {
          expect(outcome).toMatchObject({
            status: "skipped",
            action: "observe_only",
            reason: "active_embedded_run",
          });
        } else {
          expect(outcome).toMatchObject({
            status: "aborted",
            action: "abort_embedded_run",
            aborted: true,
            drained: true,
            released: 1,
          });
        }
        expect(mocks.abortEmbeddedAgentRun).toHaveBeenCalledTimes(reclaimed ? 1 : 0);
        expect(mocks.waitForEmbeddedAgentRunEnd).toHaveBeenCalledTimes(reclaimed ? 1 : 0);
        expect(mocks.resetCommandLane).toHaveBeenCalledTimes(
          reclaimed || scenario === "release" ? 1 : 0,
        );
        if (reclaimed) {
          expect(mocks.abortEmbeddedAgentRun).toHaveBeenCalledWith(sessionId);
          expect(mocks.waitForEmbeddedAgentRunEnd).toHaveBeenCalledWith(sessionId, 15_000);
        }
        if (incognito) {
          expect.soft(warnLogMessages()).toEqual([]);
        } else {
          expect(warnLogMessages().length).toBeGreaterThan(0);
          expect(warnLogMessages().join("\n")).toContain(sessionId);
          if (scenario === "returned-failure" || scenario === "internal-exception") {
            expect(warnLogMessages().join("\n")).toContain(marker);
          }
        }
        recoverTerminalTurn.mockRestore();
      }
    },
  );
});

it.for(["returned-failure", "rejected-placement"] as const)(
  "preserves ID-only privacy and %s outcomes after diagnostic state retirement",
  async (scenario, { signal }) => {
    for (const incognito of [true, false]) {
      await resetMocks();
      const sessionId = incognito ? "private-retired-id" : "ordinary-retired-id";
      const sessionKey = `agent:main:dashboard:${incognito ? "incognito-" : ""}retired`;
      const marker = incognito ? "SYNTHETIC_PRIVATE_FAILURE" : "SYNTHETIC_ORDINARY_FAILURE";
      const state = getDiagnosticSessionState({ sessionId, sessionKey });
      state.state = "processing";
      const placementStarted = createDeferred();
      const terminalTurn = createDeferred<string | undefined>();
      const recoverTerminalTurn = vi
        .spyOn(placement, "recoverTerminalSessionPlacementTurn")
        .mockImplementationOnce(() => {
          placementStarted.resolve();
          return terminalTurn.promise;
        });
      const recovery = recoverStuckDiagnosticSession({
        sessionId,
        stateGeneration: state.generation ?? 0,
        ageMs: 720_000,
        queueDepth: 1,
      });

      try {
        await withinTest(
          awaitGateBeforeSettlement(
            placementStarted.promise,
            recovery,
            "recovery completed before placement lookup",
          ),
          signal,
        );
        retireDiagnosticSessionObservations();
        pruneDiagnosticSessionStates(Date.now() + 31 * 60_000, true);
        expect(peekDiagnosticSessionState({ sessionId })).toBeUndefined();
        if (scenario === "returned-failure") {
          terminalTurn.resolve(marker);
        } else {
          terminalTurn.reject(new Error(marker));
        }
        const outcome = await withinTest(recovery, signal);

        if (incognito) {
          expect(warnLogMessages()).toEqual([]);
        } else {
          expect(warnLogMessages().join("\n")).toContain(marker);
          expect(warnLogMessages().join("\n")).toContain(sessionId);
        }
        expect(outcome).toEqual({
          status: "failed",
          action: scenario === "returned-failure" ? "fail_worker_turn" : "none",
          reason: scenario === "returned-failure" ? "terminal_worker" : "exception",
          sessionId,
          sessionKey: undefined,
          error: scenario === "returned-failure" ? marker : `Error: ${marker}`,
        });
        expect(mocks.abortEmbeddedAgentRun).not.toHaveBeenCalled();
        expect(mocks.forceClearEmbeddedAgentRun).not.toHaveBeenCalled();
        expect(mocks.waitForEmbeddedAgentRunEnd).not.toHaveBeenCalled();
        expect(mocks.resetCommandLane).not.toHaveBeenCalled();
        expect(peekDiagnosticSessionState({ sessionId })).toBeUndefined();
      } finally {
        terminalTurn.resolve(undefined);
        await recovery;
        recoverTerminalTurn.mockRestore();
      }
    }
  },
);
