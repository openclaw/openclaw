import { addAbortListener } from "node:events";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import {
  captureSessionTarget,
  runSessionMutation,
} from "../../sessions/session-controller.lifecycle.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareSessionLifecycleDrain } from "../server-methods/sessions-lifecycle-drain.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import { registerWorkerInferenceSessionControl } from "./inference-control-internal.js";
import { createWorkerInferenceServiceStub } from "./inference-control.test-helpers.js";
import { REQUEST } from "./inference.test-support.js";

it.for(["start", "start-drain-release", "refusal", "after-start"] as const)(
  "retains actual lifecycle caller custody for %s failure",
  (failureMode, { signal }) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const entered = createDeferred();
      const drained = createDeferred();
      const startFailure = new Error("selected lifecycle boundary failed");
      const drainFailure = new Error("worker drain persistence failed");
      const releaseFailure = new Error("worker drain release failed");
      const refusal = new Error("worker drain acceptance refused");
      const release = vi.fn(() => {
        if (failureMode === "start-drain-release") {
          throw releaseFailure;
        }
      });
      const start = vi.fn(() => {
        entered.resolve();
        if (failureMode !== "after-start") {
          throw startFailure;
        }
      });
      const workerService = createWorkerInferenceServiceStub();
      registerWorkerInferenceSessionControl(workerService, {
        hasSession: () => true,
        reserveSessionDrain: () => {
          if (failureMode === "refusal") {
            entered.resolve();
            throw refusal;
          }
          return { drained: drained.promise, hasWork: () => true, start, release };
        },
        captureSessionCancellation: () => ({
          runIds: [],
          settled: Promise.resolve(),
          executing: false,
          cancel: async () => [],
        }),
        resolveSessionTargetForRunId: () => undefined,
      });
      const sessionKey = `agent:main:lifecycle-custody-${failureMode}`;
      const target = {
        storePath: state.statePath("sessions.sqlite"),
        sessionKey,
        sessionId: REQUEST.sessionId,
        agentId: "main",
      };
      const identities = [sessionKey, REQUEST.sessionId];
      const abortListener = addAbortListener(signal, () => drained.resolve());
      const preparing = prepareSessionLifecycleDrain({
        action: "delete",
        authorize: () => {
          if (failureMode === "after-start" && start.mock.calls.length > 0) {
            throw startFailure;
          }
        },
        context: createGatewayRequestContext(
          makeContextParams({ workerEnvironmentService: workerService }),
        ),
        ...target,
        sessionKeys: [sessionKey],
        lifecycleIdentities: identities,
      });
      const settled = vi.fn();
      void preparing.then(settled, settled);
      const outcome = preparing.then(
        (value) => {
          value.release();
          return value;
        },
        (error: unknown) => error,
      );
      let successor: Promise<void> | undefined;
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          outcome,
          "Lifecycle caller returned before the selected worker boundary",
        );
        if (failureMode !== "refusal") {
          const successorEntered = vi.fn(async () => {});
          successor = withSessionTurn(target, successorEntered);
          // The mutation mutex is free, but accepted worker custody still
          // blocks a successor and keeps the lifecycle caller pending.
          await runSessionMutation({
            target: captureSessionTarget({
              storeScope: target.storePath,
              sessionKey,
              aliases: identities,
              incarnation: REQUEST.sessionId,
              agentId: "main",
            }),
            policy: "allow-live",
            run: async () => {},
          });
          expect(settled).not.toHaveBeenCalled();
          expect(release).not.toHaveBeenCalled();
          expect(successorEntered).not.toHaveBeenCalled();
          if (failureMode === "start") {
            drained.resolve();
          } else {
            drained.reject(drainFailure);
          }
          await successor;
          expect(successorEntered).toHaveBeenCalledOnce();
        }
        const error = await outcome;
        const callCount = failureMode === "refusal" ? 0 : 1;
        expect(start).toHaveBeenCalledTimes(callCount);
        expect(release).toHaveBeenCalledTimes(callCount);
        if (failureMode === "refusal") {
          expect(error).toBe(refusal);
        } else if (failureMode === "start") {
          expect(error).toBe(startFailure);
        } else {
          expect(error).toMatchObject({
            errors: [
              startFailure,
              drainFailure,
              ...(failureMode === "start-drain-release" ? [releaseFailure] : []),
            ],
          });
        }
      } finally {
        drained.resolve();
        await outcome;
        await successor;
        abortListener[Symbol.dispose]();
      }
    }),
);
