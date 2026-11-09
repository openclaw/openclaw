import assert from "node:assert/strict";
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

it.for(["start-drain-release", "after-start"] as const)(
  "retains actual lifecycle caller custody for %s failure",
  (failureMode, { signal }) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const entered = createDeferred();
      const drained = createDeferred();
      const startFailure = new Error("selected lifecycle boundary failed");
      const drainFailure = new Error("worker drain persistence failed");
      const releaseFailure = new Error("worker drain release failed");
      const release = vi.fn(() => assert(failureMode === "after-start", releaseFailure));
      const start = vi.fn(() => {
        entered.resolve();
        assert(failureMode === "after-start", startFailure);
      });
      const workerService = createWorkerInferenceServiceStub();
      const accepted = { drained: drained.promise, hasWork: () => true, start, release };
      registerWorkerInferenceSessionControl(workerService, {
        hasSession: () => true,
        reserveSessionDrain: () => accepted,
        captureSessionCancellation: () => {
          throw new Error("Cancellation must not follow failed admission");
        },
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
        (value) => value.release(),
        (error: unknown) => error,
      );
      let successor: Promise<void> | undefined;
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          outcome,
          "Lifecycle caller returned before the selected worker boundary",
        );
        const successorEntered = vi.fn(async () => {});
        successor = withSessionTurn(target, successorEntered);
        // Accepted custody blocks turns but not mutations until the drain settles.
        await runSessionMutation({
          target: captureSessionTarget({
            storeScope: target.storePath,
            ...target,
            aliases: identities,
            incarnation: REQUEST.sessionId,
          }),
          policy: "allow-live",
          run: async () => {},
        });
        expect(settled).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
        expect(successorEntered).not.toHaveBeenCalled();
        drained.reject(drainFailure);
        await successor;
        expect(successorEntered).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();
        const errors = [startFailure, drainFailure];
        if (failureMode === "start-drain-release") {
          errors.push(releaseFailure);
        }
        expect(await outcome).toMatchObject({ errors });
      } finally {
        drained.resolve();
        await outcome;
        await successor;
        abortListener[Symbol.dispose]();
      }
    }),
);
