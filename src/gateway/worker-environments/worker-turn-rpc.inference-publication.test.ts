import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import {
  WORKER_INFERENCE_PROTOCOL_FEATURE,
  validateWorkerInferenceTerminalFrame,
  type WorkerInferenceTerminalFrame,
  type WorkerInferenceTerminalOutcome,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { dispatchWorkerRequest } from "../server/ws-connection/worker-connection-dispatch.js";
import * as support from "./service.test-support.js";
import {
  bindClaimOwner,
  claimAdmission,
  claimService,
} from "./worker-turn-rpc-fixtures.test-support.js";
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
      ...[context, operation, options]: Parameters<typeof actual.runOpenClawStateWorkerOperation>
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
const inferenceFrame = (event: string, payload: unknown) => ({
  type: "event",
  event: `worker.inference.${event}`,
  payload,
});
const done: WorkerInferenceTerminalOutcome = {
  type: "done",
  message: {
    ...makeAgentAssistantMessage({ content: [{ type: "text", text: delta.delta }] }),
    stopReason: "stop",
  },
};

support.setupWorkerEnvironmentServiceSuite();

it.each(["diagnostic", "credential revocation"] as const)(
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
    const { claim, store: placements } = await claimWorkerPlacement({
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
    const workerService = claimService(placements, { executeInference });
    let mutation: Promise<unknown> | undefined;
    let owner: Awaited<ReturnType<typeof bindClaimOwner>> | undefined;
    try {
      owner = await bindClaimOwner(placements, claim, {
        assertCurrent: () => {
          if (!placements.validateTurnClaim(claim)) {
            throw new Error("Worker publication fixture claim is no longer current");
          }
        },
      });
      const grant = await workerService.acquireTurnCredential(claim);
      expect(await workerService.acknowledgeCredentialDelivery(grant)).toBe(true);
      const admission = await workerService.admitWorker(
        claimAdmission(claim, grant.credential, receipt),
      );
      assert(admission.ok, "Worker inference admission failed");
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
      const providerSignal = await awaitGateBeforeSettlement(
        entered.promise,
        terminalDelivered.promise,
        "Inference terminated before provider execution",
      );
      delivery.command =
        mutationKind === "diagnostic"
          ? "workerEnvironments.recordError"
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
          : store.revokeEnvironmentCredential(environmentId);
      await awaitGateBeforeSettlement(
        committed.promise,
        mutation,
        "Inventory mutation finished before its publication gate",
      );
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
          inferenceFrame("event", { ...binding, seq: 1, event: delta }),
          inferenceFrame("terminal", { ...binding, seq: 2, outcome: done }),
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
      if (placements.validateTurnClaim(claim)) {
        await placements.releaseTurn(claim);
      }
      owner?.release();
    }
  },
);
