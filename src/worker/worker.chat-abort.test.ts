import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkerLiveEventParams } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/config.js";
import { registerChatAbortController } from "../gateway/chat-abort.js";
import {
  createChatAbortContext,
  invokeChatAbortHandler,
} from "../gateway/server-methods/chat.abort.test-helpers.js";
import { coreGatewayHandlers } from "../gateway/server-methods/core-handlers.js";
import { claimRpcSourceForTest } from "../gateway/test-helpers.rpc-source.js";
import { hashWorkerCredential } from "../gateway/worker-environments/credential.js";
import { projectWorkerSessionTurnClaim } from "../gateway/worker-environments/placement-record.js";
import { createWorkerTurnRunOwner } from "../gateway/worker-environments/worker-turn-run-owner.js";
import {
  getAgentEventLifecycleGeneration,
  onAgentRuntimeEvent,
  rotateAgentEventLifecycleGeneration,
} from "../infra/agent-events.js";
import {
  claimAgentRunContext,
  getActiveAgentRunDelegatedAuthority,
  getAgentRunContext,
} from "../infra/agent-run-registry.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import {
  ComposedGatewayHarness,
  ENVIRONMENT_ID,
  RUN_ID,
  SESSION_ID,
  SESSION_KEY,
  doneOutcome,
} from "./worker-fault-injection.test-support.js";
import { createWorkerProcessTestHarness } from "./worker-process.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const workers = createWorkerProcessTestHarness((prefix) => tempDirs.make(prefix));

let harness: ComposedGatewayHarness;
let activeTestSignal: AbortSignal;
let previousConfig: ReturnType<typeof getRuntimeConfigSnapshot>;
let previousSourceConfig: ReturnType<typeof getRuntimeConfigSourceSnapshot>;

beforeEach(async ({ signal }) => {
  activeTestSignal = signal;
  // Capture config before harness storage pins its locator as the runtime snapshot.
  previousConfig = getRuntimeConfigSnapshot();
  previousSourceConfig = getRuntimeConfigSourceSnapshot();
  harness = await ComposedGatewayHarness.create(tempDirs.make("oc-wa-"));
  await harness.start();
});

afterEach(async ({ signal }) => {
  try {
    await workers.close(signal);
    await harness.close();
  } finally {
    if (previousConfig) {
      setRuntimeConfigSnapshot(previousConfig, previousSourceConfig ?? undefined);
    } else {
      clearRuntimeConfigSnapshot();
    }
  }
});

it.each([
  { queuedPreview: false, fence: "none" },
  { queuedPreview: true, fence: "none" },
  { queuedPreview: true, fence: "claim" },
  { queuedPreview: true, fence: "credential" },
  { queuedPreview: true, fence: "run owner" },
  { queuedPreview: true, fence: "lifecycle" },
  { queuedPreview: true, fence: "before durable ACK" },
  { queuedPreview: true, fence: "after durable ACK" },
] as const)(
  "settles managed chat.abort with queued preview $queuedPreview and $fence fence",
  async ({ queuedPreview, fence }) => {
    const signal = activeTestSignal;
    const placements = harness.placementStore;
    const cursor = () => placements.get(SESSION_ID)?.lastLiveEventAckCursor;
    const descriptor = await harness.createDescriptor();
    descriptor.assignment.toolAuthority.exec = {
      host: "gateway",
      security: "full",
      ask: "off",
      safeBins: [],
    };
    const claim = expectDefined(
      projectWorkerSessionTurnClaim(placements.get(SESSION_ID)!),
      "worker turn claim",
    );
    const runContext = {
      agentId: "main",
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
    };
    claimAgentRunContext(RUN_ID, {
      ...runContext,
      isControlUiVisible: true,
    });
    const context = createChatAbortContext({
      chatRunState: harness.chat.state,
      getRuntimeConfig: () => harness.cfg,
      workerEnvironmentService: harness.serviceValue,
      removeChatRun: (...args: Parameters<typeof harness.chat.state.registry.remove>) =>
        harness.chat.state.registry.remove(...args),
    });
    let deliverCancellation: (() => void) | undefined;
    const authority = expectDefined(
      getActiveAgentRunDelegatedAuthority(descriptor.assignment.operationalRunInstance),
      "managed worker turn authority",
    );
    const registration = registerChatAbortController({
      target: captureSessionTarget({
        storeScope: harness.sessionTarget.storePath,
        sessionKey: SESSION_KEY,
        incarnation: SESSION_ID,
        agentId: "main",
      }),
      runId: RUN_ID,
      ...runContext,
      ownerConnId: "fault-operator",
      controlUiVisible: true,
      operationalRunInstance: authority.operationalRunInstance,
      timeoutMs: 60_000,
      kind: "chat-send",
    });
    if (!registration.registered) {
      throw new Error("Expected worker source admission");
    }
    registration.bindAgentRunDelegatedAuthority(authority);
    registration.initializeTiming();
    const releaseSource = await claimRpcSourceForTest(registration.entry);
    const operation = expectDefined(registration.entry.input.claim?.operation, "worker operation");
    expect(registration.markExecutionStarted()).toBe(true);
    const ownerInput = {
      placements,
      isReplyDelivered: () => false,
      claim,
      sessionKey: SESSION_KEY,
      turn: {
        ...runContext,
        sessionFile: SESSION_KEY,
        sessionTarget: harness.sessionTarget,
        workspaceDir: harness.root,
        prompt: "fault injection",
        timeoutMs: 60_000,
        runId: RUN_ID,
        config: harness.cfg,
        abortSignal: registration.controller.signal,
        replyOperation: operation,
      },
    };
    const owner = await createWorkerTurnRunOwner(ownerInput);
    const ackEntered = createDeferred();
    const ackRelease = createDeferred();
    const { release: providerRelease, started: providerStarted } = harness.planPending();
    const previewRelease = createDeferred();
    if (queuedPreview) {
      harness.providerPlan = {
        kind: "live-preview",
        nextRelease: previewRelease,
        produced: createDeferred(),
        text: "preview reply",
      };
    }
    const previewGate = queuedPreview
      ? harness.addLiveEventGate("before-service", "preview")
      : undefined;
    const finishingGate = harness.addLiveEventGate("before-service", "finishing");
    const liveStarted = createDeferred();
    const outerCancelled = createDeferred();
    let publishedEvents = 0;
    const unsubscribe = onAgentRuntimeEvent((event) => {
      if (event.runId !== RUN_ID) {
        return;
      }
      publishedEvents += 1;
      if (event.stream === "lifecycle" && event.data.phase === "start") {
        liveStarted.resolve();
      }
      if (event.stream === "lifecycle" && event.data.status === "cancelled") {
        outerCancelled.resolve();
      }
    });
    let stdout = "";
    let cancelWorker: (() => void) | undefined;
    let command: Promise<void> | undefined;
    try {
      const worker = await workers.launch({ descriptor, signal });
      cancelWorker = () => {
        if (fence === "after durable ACK") {
          // Let the Gateway's inference cancellation arrive before local cancellation.
          deliverCancellation = () => worker.cancel();
        } else {
          worker.cancel();
        }
      };
      owner.signal.addEventListener("abort", cancelWorker, { once: true });
      command = worker.finish().then((exit) => {
        stdout = exit.stdout;
        if (exit.code !== 0) {
          throw new Error(exit.stderr || `Worker exited with code ${exit.code}`);
        }
      });
      // Register the rejection handler before waiting for worker lifecycle events.
      void command.catch(() => undefined);
      const waitFor = (gate: PromiseLike<void>, boundary: string) =>
        withinTest(
          awaitGateBeforeSettlement(gate, command!, `worker command completed before ${boundary}`),
          signal,
        );
      await waitFor(liveStarted.promise, "live start");
      await waitFor(
        previewGate?.entered.promise ?? providerStarted.promise,
        "cancellation boundary",
      );
      expect(getAgentRunContext(RUN_ID)).toMatchObject({
        sessionId: SESSION_ID,
        isControlUiVisible: true,
      });
      const respond = await invokeChatAbortHandler({
        handler: coreGatewayHandlers["chat.abort"]!,
        context,
        request: { sessionKey: SESSION_KEY, runId: RUN_ID },
        client: { connId: "fault-operator", connect: { scopes: ["operator.admin"] } },
      });
      expect(respond).toHaveBeenCalledWith(true, { ok: true, aborted: true, runIds: [RUN_ID] });
      await waitFor(outerCancelled.promise, "outer cancellation");
      expect(owner.signal.aborted).toBe(true);
      expect(getAgentRunContext(RUN_ID)).toBeUndefined();
      expect(placements.validateTurnClaim(claim)).toBe(true);
      const publishedAtAbort = publishedEvents;
      previewGate?.release.resolve();
      await waitFor(finishingGate.entered.promise, "cancellation finishing");
      deliverCancellation?.();
      const cursorAtAbort = cursor();
      if (fence === "claim") {
        await harness.settleRun(RUN_ID);
      } else if (fence === "credential") {
        const credential = harness.store.getCredential(ENVIRONMENT_ID)!;
        await harness.store.renewCredential({
          environmentId: ENVIRONMENT_ID,
          expectedOwnerEpoch: harness.epoch,
          sessionId: SESSION_ID,
          rpcSetVersion: credential.rpcSetVersion,
          expiresAtMs: credential.expiresAtMs,
          credentialHash: hashWorkerCredential("synthetic-replacement-credential", claim),
        });
      } else if (fence === "run owner") {
        owner.dispose();
      } else if (fence === "lifecycle") {
        rotateAgentEventLifecycleGeneration();
      }
      const replaceDuringAck = fence === "before durable ACK" || fence === "after durable ACK";
      if (replaceDuringAck) {
        const updateAckCursors = placements.updateAckCursors.bind(placements);
        vi.spyOn(placements, "updateAckCursors").mockImplementationOnce(
          async (ackInput, assertCurrent) => {
            if (fence === "before durable ACK") {
              ackEntered.resolve();
              await ackRelease.promise;
              return updateAckCursors(ackInput, assertCurrent);
            }
            const record = await updateAckCursors(ackInput, assertCurrent);
            ackEntered.resolve();
            await ackRelease.promise;
            return record;
          },
        );
      }
      finishingGate.release.resolve();
      if (replaceDuringAck) {
        await waitFor(ackEntered.promise, "durable ACK boundary");
        await expect(
          createWorkerTurnRunOwner({
            ...ownerInput,
            turn: { ...ownerInput.turn, abortSignal: undefined },
          }),
        ).rejects.toThrow("Worker attempt retired");
        owner.dispose();
        ackRelease.resolve();
      }
      const failure = await command.then(
        () => undefined,
        (error: unknown) => error,
      );
      const liveRequests = harness
        .requestParams("worker.live-event")
        .map((request) => request as WorkerLiveEventParams);
      const finishing = liveRequests.findLast(
        ({ event }) => event.kind === "lifecycle" && event.payload.phase === "finishing",
      );
      expect(publishedEvents).toBe(publishedAtAbort);
      expect(getAgentRunContext(RUN_ID)).toBeUndefined();
      expect(harness.providerCalls).toBe(1);
      if (fence !== "none") {
        const afterAck = fence === "after durable ACK";
        if (afterAck) {
          expect(finishing).toBeDefined();
        }
        expect(cursor()).toBe(afterAck ? finishing?.seq : cursorAtAbort);
        expect(await placements.listPendingWorkspaceResultsAsync()).toEqual(
          afterAck ? [expect.anything()] : [],
        );
        if (fence === "credential") {
          expect(failure).toBeUndefined();
          expect(JSON.parse(stdout)).toMatchObject({
            result: { status: "fenced", reason: "credential-replaced" },
          });
        } else {
          expect(failure).toBeInstanceOf(Error);
          expect(stdout).toBe("");
        }
        return;
      }
      expect(failure).toBeUndefined();
      expect(finishing).toBeDefined();
      expect(finishing?.event).toMatchObject({
        kind: "lifecycle",
        payload: { phase: "finishing", aborted: true, stopReason: "aborted" },
      });
      expect(cursor()).toBe(finishing?.seq);
      expect(JSON.parse(stdout)).toMatchObject({
        type: "result",
        turnId: descriptor.assignment.turnId,
        retainWorker: false,
        result: { status: "failed", reason: "turn-failed" },
      });
    } finally {
      previewGate?.release.resolve();
      finishingGate.release.resolve();
      ackRelease.resolve();
      previewRelease.resolve();
      providerRelease.resolve(doneOutcome("fixture teardown"));
      try {
        await workers.close(signal);
        if (command) {
          await Promise.allSettled([command]);
        }
      } finally {
        if (cancelWorker) {
          owner.signal.removeEventListener("abort", cancelWorker);
        }
        owner.dispose();
        registration.cleanup();
        releaseSource();
        await registration.entry.input.settlement.promise;
        unsubscribe();
      }
    }
  },
);
