import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
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
        captureSessionCancellation: () => ({ runIds: [], cancel: async () => [] }),
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
      const releaseRawDrain = () => drained.resolve();
      signal.addEventListener("abort", releaseRawDrain, { once: true });
      if (signal.aborted) {
        releaseRawDrain();
      }
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
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      let successor: Promise<void> | undefined;
      try {
        await Promise.race([
          entered.promise,
          outcome.then(() => {
            throw new Error("Lifecycle caller returned before the selected worker boundary");
          }),
        ]);
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
        const result = await outcome;
        if (result.ok) {
          result.value.release();
          throw new Error("Lifecycle caller discarded its worker failure");
        }
        if (failureMode === "refusal") {
          expect(result.error).toBe(refusal);
          expect(start).not.toHaveBeenCalled();
          expect(release).not.toHaveBeenCalled();
        } else {
          expect(start).toHaveBeenCalledOnce();
          expect(release).toHaveBeenCalledOnce();
          if (failureMode === "start") {
            expect(result.error).toBe(startFailure);
          } else {
            expect(result.error).toMatchObject({
              errors: [
                startFailure,
                drainFailure,
                ...(failureMode === "start-drain-release" ? [releaseFailure] : []),
              ],
            });
          }
        }
      } finally {
        releaseRawDrain();
        await outcome;
        await successor;
        signal.removeEventListener("abort", releaseRawDrain);
      }
    }),
);
