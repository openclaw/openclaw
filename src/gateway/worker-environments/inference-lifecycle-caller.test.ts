import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareSessionLifecycleDrain } from "../server-methods/sessions-lifecycle-drain.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import { registerWorkerInferenceSessionControl } from "./inference-control-internal.js";
import { REQUEST } from "./inference.test-support.js";
import type { WorkerEnvironmentServiceContract } from "./service-contract.js";

describe("worker inference lifecycle caller", () => {
  it.for(["start", "start-and-drain", "start-drain-release", "refusal", "after-start"] as const)(
    "retains actual lifecycle caller custody for %s failure",
    async (failureMode, { signal }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const entered = createDeferred();
        const drained = createDeferred();
        const startFailure = new Error("selected lifecycle boundary failed");
        const drainFailure = new Error("worker drain persistence failed");
        const releaseFailure = new Error("worker drain release failed");
        const refusal = new Error("worker drain acceptance refused");
        const unacceptedRelease = vi.fn();
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
        const unexpected = (): never => {
          throw new Error("Unexpected worker service operation during drain acquisition");
        };
        const workerService = {
          getDedicatedNodeLeaseSignal: unexpected,
          captureSessionAttachment: unexpected,
          getSessionAttachment: unexpected,
          findSessionAttachment: unexpected,
          getSessionAttachmentStatus: unexpected,
          assertSessionAttachment: unexpected,
          touchSessionAttachment: unexpected,
          execSessionAttachment: unexpected,
          createSessionAttachment: unexpected,
          destroySessionAttachment: unexpected,
          openNodePortal: unexpected,
          list: unexpected,
          readPreparedPoolSummary: unexpected,
          readReadyWorkerTarget: unexpected,
          get: () => undefined,
          inventoryVersion: unexpected,
          readMachineShape: unexpected,
          machineShapeVersion: unexpected,
          supportsExecutionMode: unexpected,
          readProviderDisplayId: unexpected,
          listMachineOptions: unexpected,
          listOperatingSystems: unexpected,
          prepare: unexpected,
          create: unexpected,
          destroy: unexpected,
          destroyUnattached: unexpected,
          observeDesktop: unexpected,
          launchDesktopApp: unexpected,
          startTunnel: unexpected,
          stopTunnel: unexpected,
          hasInferenceForSession: () => true,
        } satisfies WorkerEnvironmentServiceContract & { hasInferenceForSession(): boolean };
        registerWorkerInferenceSessionControl(workerService, {
          reserveDrain: () => ({
            assertReserved: () => {},
            release: unacceptedRelease,
            accept: () => {
              if (failureMode === "refusal") {
                entered.resolve();
                throw refusal;
              }
              return { drained: drained.promise, hasWork: () => true, start, release };
            },
          }),
          captureCancel: () => ({ runIds: [], cancel: async () => [] }),
          resolveTarget: () => undefined,
        });
        const sessionKey = `agent:main:lifecycle-custody-${failureMode}`;
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
          storePath: state.statePath("sessions.sqlite"),
          sessionKeys: [sessionKey],
          sessionId: REQUEST.sessionId,
          agentId: "main",
          sessionKey,
          lifecycleIdentities: identities,
        });
        const settled = vi.fn();
        void preparing.then(settled, settled);
        const outcome = preparing.then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        try {
          await Promise.race([
            entered.promise,
            outcome.then(() => {
              throw new Error("Lifecycle caller returned before the selected worker boundary");
            }),
          ]);
          if (failureMode !== "refusal") {
            await runExclusiveSessionLifecycleMutation({
              scope: state.statePath("sessions.sqlite"),
              identities,
              run: async () => {},
            });
            expect(settled).not.toHaveBeenCalled();
            expect(release).not.toHaveBeenCalled();
            if (failureMode === "start") {
              drained.resolve();
            } else {
              drained.reject(drainFailure);
            }
          }
          const result = await outcome;
          if (result.ok) {
            result.value.release();
            throw new Error("Lifecycle caller discarded its worker failure");
          }
          if (failureMode === "refusal") {
            expect(result.error).toBe(refusal);
            expect(unacceptedRelease).toHaveBeenCalledOnce();
            expect(start).not.toHaveBeenCalled();
            expect(release).not.toHaveBeenCalled();
          } else {
            expect(start).toHaveBeenCalledOnce();
            expect(unacceptedRelease).not.toHaveBeenCalled();
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
          signal.removeEventListener("abort", releaseRawDrain);
        }
      });
    },
  );
});
