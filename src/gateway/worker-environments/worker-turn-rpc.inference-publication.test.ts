import { describe, expect, it, vi } from "vitest";
import {
  WORKER_INFERENCE_PROTOCOL_FEATURE,
  validateWorkerInferenceTerminalFrame,
  type WorkerInferenceTerminalFrame,
  type WorkerInferenceTerminalOutcome,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { dispatchWorkerRequest } from "../server/ws-connection/worker-connection-dispatch.js";
import { hashWorkerCredential } from "./credential.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";
import { claimWorkerPlacement } from "./worker-turn-rpc.test-support.js";

const delivery = vi.hoisted(() => ({
  command: undefined as string | undefined,
  afterCommit: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("../../state/openclaw-state-worker-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../state/openclaw-state-worker-store.js")>();
  return {
    ...actual,
    runOpenClawStateWorkerOperation: (
      context: Parameters<typeof actual.runOpenClawStateWorkerOperation>[0],
      operation: Parameters<typeof actual.runOpenClawStateWorkerOperation>[1],
      options: Parameters<typeof actual.runOpenClawStateWorkerOperation>[2],
    ) =>
      actual.runOpenClawStateWorkerOperation(
        context,
        (scope) =>
          operation({
            execute: async (command, executeOptions) => {
              const result = await scope.execute(command, executeOptions);
              if (command.type === delivery.command) {
                await delivery.afterCommit?.();
              }
              return result;
            },
          }),
        options,
      ),
  };
});

const delta = { type: "text_delta", contentIndex: 0, delta: "preserved provider output" } as const;
const done: WorkerInferenceTerminalOutcome = {
  type: "done",
  message: {
    role: "assistant",
    content: [{ type: "text", text: delta.delta }],
    api: "openai-responses",
    provider: "fake",
    model: "model-test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  },
};

describe("worker inference inventory publication", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each(["diagnostic", "credential replacement", "credential revocation"] as const)(
    "revalidates provider output while %s commit publication is delayed",
    async (mutationKind) => {
      const { store } = support.testState;
      const environmentId = "worker-inference-publication";
      const sessionId = "session-inference-publication";
      const receipt = {
        ...support.BOOTSTRAP_RECEIPT,
        protocolFeatures: [WORKER_INFERENCE_PROTOCOL_FEATURE],
      };
      support.testState.prepareInstallation = vi.fn(async () => ({
        ...support.BUNDLE_ARTIFACT,
        protocolFeatures: receipt.protocolFeatures,
      }));
      const bootstrapping = await support.seedBootstrapping(environmentId);
      await store.transition({
        environmentId,
        from: bootstrapping.state,
        to: "ready",
        patch: support.readyPatch(environmentId, receipt),
      });
      const attached = await store.transition({
        environmentId,
        from: "ready",
        to: "attached",
        patch: support.attachedPatch(environmentId, sessionId),
      });
      const { claim, store: placements } = claimWorkerPlacement({
        environmentId,
        ownerEpoch: attached.ownerEpoch,
        sessionId,
      });
      const entered = createDeferredCore<AbortSignal>();
      const continueProvider = createDeferredCore();
      const committed = createDeferredCore();
      const publish = createDeferredCore();
      const terminalDelivered = createDeferredCore<WorkerInferenceTerminalFrame>();
      const frames: unknown[] = [];
      const executeInference = vi.fn<support.WorkerEnvironmentServiceOptions["executeInference"]>(
        async ({ signal, emit }) => {
          entered.resolve(signal);
          await continueProvider.promise;
          emit(delta);
          return done;
        },
      );
      const workerService = support.createService(support.createProvider(), {
        executeInference,
        placementStore: createWorkerSessionPlacementGate(placements),
      });
      let mutation: Promise<unknown> | undefined;
      try {
        const grant = await workerService.acquireTurnCredential(claim);
        expect(await workerService.acknowledgeCredentialDelivery(grant)).toBe(true);
        const admission = await workerService.admitWorker({
          environmentId,
          credential: grant.credential,
          sessionId,
          runId: claim.runId,
          ownerEpoch: attached.ownerEpoch,
          rpcSetVersion: 1,
          handshake: receipt,
        });
        if (!admission.ok) {
          throw new Error(`Worker inference admission failed: ${admission.reason}`);
        }
        const identity = admission.identity;
        const request = support.inferenceRequest(identity);
        const respond = vi.fn();
        await dispatchWorkerRequest({
          request: {
            type: "req",
            id: "inference-publication",
            method: "worker.inference.start",
            params: request,
          },
          identity,
          connectionId: "inference-publication-connection",
          service: workerService,
          send: (frame) => {
            frames.push(frame);
            if (validateWorkerInferenceTerminalFrame(frame)) {
              terminalDelivered.resolve(frame);
            }
          },
          respond,
          close: vi.fn(),
          warn: vi.fn(),
        });
        expect(respond).toHaveBeenCalledExactlyOnceWith(true, { status: "accepted" });
        const providerSignal = await Promise.race([
          entered.promise,
          terminalDelivered.promise.then(() => {
            throw new Error("Inference terminated before provider execution");
          }),
        ]);
        delivery.command =
          mutationKind === "diagnostic"
            ? "workerEnvironments.recordError"
            : mutationKind === "credential replacement"
              ? "workerEnvironments.renewCredential"
              : "workerEnvironments.revokeEnvironmentCredential";
        delivery.afterCommit = async () => {
          committed.resolve();
          await publish.promise;
        };
        mutation =
          mutationKind === "diagnostic"
            ? store.recordError({
                environmentId,
                state: "attached",
                error: "unrelated provider diagnostic",
              })
            : mutationKind === "credential replacement"
              ? store.renewCredential({
                  environmentId,
                  expectedOwnerEpoch: identity.ownerEpoch,
                  credentialHash: hashWorkerCredential("replacement-inference-credential"),
                  sessionId,
                  rpcSetVersion: 1,
                  expiresAtMs: support.testState.nowMs + 60_000,
                })
              : store.revokeEnvironmentCredential(environmentId);
        await Promise.race([
          committed.promise,
          mutation.then(() => {
            throw new Error("Inventory mutation finished before its publication gate");
          }),
        ]);
        continueProvider.resolve();
        const terminal = await terminalDelivered.promise;
        expect(providerSignal.aborted).toBe(mutationKind !== "diagnostic");
        if (mutationKind === "diagnostic") {
          const binding = {
            runEpoch: request.runEpoch,
            sessionId: request.sessionId,
            runId: request.runId,
            turnId: request.turnId,
          };
          expect(frames).toEqual([
            {
              type: "event",
              event: "worker.inference.event",
              payload: { ...binding, seq: 1, event: delta },
            },
            {
              type: "event",
              event: "worker.inference.terminal",
              payload: { ...binding, seq: 2, outcome: done },
            },
          ]);
        } else {
          expect(frames).toEqual([terminal]);
          expect(terminal.payload.outcome).toMatchObject({ type: "error" });
        }
        expect(executeInference).toHaveBeenCalledOnce();
        publish.resolve();
        await mutation;
      } finally {
        continueProvider.resolve();
        publish.resolve();
        await Promise.allSettled([mutation]);
        delivery.command = undefined;
        delivery.afterCommit = undefined;
        await workerService.stop();
      }
    },
  );
});
