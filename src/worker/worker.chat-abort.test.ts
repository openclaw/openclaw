import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, onTestFailed, vi } from "vitest";
import type { WorkerLiveEventParams } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerInferenceTerminalOutcome } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
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
import { runWorkerCommand } from "./worker-command.runtime.js";
import {
  ComposedGatewayHarness,
  ENVIRONMENT_ID,
  RUN_ID,
  SESSION_ID,
  SESSION_KEY,
  doneOutcome,
} from "./worker-fault-injection.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("worker chat.abort settlement", () => {
  let harness: ComposedGatewayHarness;

  beforeEach(async () => {
    harness = await ComposedGatewayHarness.create(tempDirs.make("oc-wa-"));
    await harness.start();
  });

  afterEach(async () => {
    await harness.close();
  });

  it.each([
    { queuedPreview: false, fence: "none" },
    { queuedPreview: true, fence: "none" },
    { queuedPreview: true, fence: "claim" },
    { queuedPreview: true, fence: "credential" },
    { queuedPreview: true, fence: "run owner" },
    { queuedPreview: true, fence: "lifecycle" },
  ] as const)(
    "settles managed chat.abort with queued preview $queuedPreview and $fence fence",
    async ({ queuedPreview, fence }) => {
      const descriptor = await harness.createDescriptor();
      descriptor.assignment.toolAuthority.exec = {
        host: "gateway",
        security: "full",
        ask: "off",
        safeBins: [],
      };
      const claim = projectWorkerSessionTurnClaim(harness.placementStore.get(SESSION_ID)!);
      expect(claim).toBeDefined();
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      claimAgentRunContext(RUN_ID, {
        agentId: "main",
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        lifecycleGeneration,
        isControlUiVisible: true,
      });
      const context = createChatAbortContext({
        chatRunState: harness.chat.state,
        getRuntimeConfig: () => harness.cfg,
        workerEnvironmentService: harness.serviceValue,
        removeChatRun: (...args: Parameters<typeof harness.chat.state.registry.remove>) =>
          harness.chat.state.registry.remove(...args),
      });
      const authority = getActiveAgentRunDelegatedAuthority(
        descriptor.assignment.operationalRunInstance,
      );
      if (!authority) {
        throw new Error("managed worker turn has no admitted authority");
      }
      const registration = registerChatAbortController({
        chatAbortControllers: context.chatAbortControllers,
        runId: RUN_ID,
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        agentId: "main",
        ownerConnId: "fault-operator",
        controlUiVisible: true,
        lifecycleGeneration,
        operationalRunInstance: authority.operationalRunInstance,
        timeoutMs: 60_000,
        kind: "chat-send",
      });
      registration.bindAgentRunDelegatedAuthority(authority);
      registration.markExecutionStarted();
      const owner = createWorkerTurnRunOwner({
        placements: harness.placementStore,
        claim: claim!,
        sessionKey: SESSION_KEY,
        turn: {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          sessionFile: SESSION_KEY,
          sessionTarget: harness.sessionTarget,
          workspaceDir: harness.root,
          prompt: "fault injection",
          timeoutMs: 60_000,
          runId: RUN_ID,
          config: harness.cfg,
          lifecycleGeneration,
          abortSignal: registration.controller.signal,
        },
      });
      const providerRelease = createDeferred<WorkerInferenceTerminalOutcome>();
      const providerStarted = createDeferred();
      const previewRelease = createDeferred();
      harness.providerPlan = queuedPreview
        ? {
            kind: "live-preview",
            nextRelease: previewRelease,
            produced: createDeferred(),
            text: "preview reply",
          }
        : { kind: "pending", started: providerStarted, release: providerRelease };
      const previewGate = queuedPreview
        ? harness.addLiveEventGate("before-service", "preview")
        : undefined;
      const finishingGate = harness.addLiveEventGate("before-service", "finishing");
      const liveStarted = createDeferred();
      const outerCancelled = createDeferred();
      const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
      const unsubscribe = onAgentRuntimeEvent((event) => {
        if (event.runId !== RUN_ID) {
          return;
        }
        events.push({ stream: event.stream, data: event.data });
        if (event.stream === "lifecycle" && event.data.phase === "start") {
          liveStarted.resolve();
        }
        if (event.stream === "lifecycle" && event.data.status === "cancelled") {
          outerCancelled.resolve();
        }
      });
      const input = new PassThrough();
      const output = new PassThrough();
      let stdout = "";
      output.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      const lifetimeController = new AbortController();
      const cancelWorker = () => {
        input.write(
          `${JSON.stringify({ type: "cancel", turnId: descriptor.assignment.turnId })}\n`,
        );
      };
      owner.signal.addEventListener("abort", cancelWorker, { once: true });
      const previousConfig = getRuntimeConfigSnapshot();
      const previousSourceConfig = getRuntimeConfigSourceSnapshot();
      setRuntimeConfigSnapshot(harness.cfg);
      const startedAt = performance.now();
      let phase = "command-start";
      let commandOutcome = "pending";
      const captureTrace = () => ({
        phase,
        elapsedMs: Math.round(performance.now() - startedAt),
        commandOutcome,
        requestCounts: Object.fromEntries(
          [...new Set(harness.requests.map(({ method }) => method))].map((method) => [
            method,
            harness.requestParams(method).length,
          ]),
        ),
        publishedEvents: events.length,
        providerCalls: harness.providerCalls,
      });
      let failureTrace: ReturnType<typeof captureTrace> | undefined;
      onTestFailed(() => {
        console.error("worker chat.abort phase", failureTrace ?? captureTrace());
      });
      const command = runWorkerCommand({
        input,
        output,
        managed: true,
        lifetime: {
          signal: lifetimeController.signal,
          started: Promise.resolve(true),
          dispose: vi.fn(),
          reportConnectionFailure: vi.fn(),
          terminateOwnedTree: vi.fn(),
        },
      });
      void command.then(
        () => {
          commandOutcome = "completed";
        },
        () => {
          commandOutcome = "rejected";
        },
      );
      input.write(
        `${JSON.stringify({ type: "turn", turnId: descriptor.assignment.turnId, descriptor })}\n`,
      );
      try {
        phase = "waiting-live-start";
        await withTestTimeout(
          Promise.race([
            liveStarted.promise,
            command.then(() => {
              throw new Error("worker command completed before live start");
            }),
          ]),
          10_000,
          "worker live start was not published",
        );
        phase = "waiting-cancellation-boundary";
        await withTestTimeout(
          previewGate?.entered.promise ?? providerStarted.promise,
          10_000,
          "worker did not reach the cancellation boundary",
        );
        expect(getAgentRunContext(RUN_ID)?.sessionId).toBe(SESSION_ID);
        const respond = await invokeChatAbortHandler({
          handler: coreGatewayHandlers["chat.abort"]!,
          context,
          request: { sessionKey: SESSION_KEY, runId: RUN_ID },
          client: { connId: "fault-operator", connect: { scopes: ["operator.admin"] } },
        });
        expect(respond).toHaveBeenCalledWith(true, { ok: true, aborted: true, runIds: [RUN_ID] });
        phase = "waiting-outer-cancellation";
        await outerCancelled.promise;
        expect(owner.signal.aborted).toBe(true);
        expect(getAgentRunContext(RUN_ID)).toBeUndefined();
        expect(harness.placementStore.validateTurnClaim(claim!)).toBe(true);
        const publishedAtAbort = events.length;
        previewGate?.release.resolve();
        phase = "waiting-worker-finishing";
        await withTestTimeout(
          Promise.race([
            finishingGate.entered.promise,
            command.then(() => {
              throw new Error(
                `worker command completed before cancellation finishing: ${stdout || "no result"}`,
              );
            }),
          ]),
          10_000,
          "worker did not finish cancellation",
        );
        const cursorAtAbort = harness.placementStore.get(SESSION_ID)?.lastLiveEventAckCursor;
        if (fence === "claim") {
          harness.settleRun(RUN_ID);
        } else if (fence === "credential") {
          const credential = harness.store.getCredential(ENVIRONMENT_ID)!;
          await harness.store.renewCredential({
            environmentId: ENVIRONMENT_ID,
            expectedOwnerEpoch: harness.epoch,
            sessionId: SESSION_ID,
            rpcSetVersion: credential.rpcSetVersion,
            expiresAtMs: credential.expiresAtMs,
            credentialHash: hashWorkerCredential("synthetic-replacement-credential", claim!),
          });
        } else if (fence === "run owner") {
          owner.dispose();
        } else if (fence === "lifecycle") {
          rotateAgentEventLifecycleGeneration();
        }
        finishingGate.release.resolve();
        phase = "waiting-command-settlement";
        const failure = await command.then(
          () => undefined,
          (error: unknown) => error,
        );
        const liveRequests = harness
          .requestParams("worker.live-event")
          .map((request) => request as WorkerLiveEventParams);
        expect(events).toHaveLength(publishedAtAbort);
        expect(getAgentRunContext(RUN_ID)).toBeUndefined();
        expect(harness.providerCalls).toBe(1);
        if (fence !== "none") {
          expect(harness.placementStore.get(SESSION_ID)?.lastLiveEventAckCursor).toBe(
            cursorAtAbort,
          );
          expect(harness.placementStore.listPendingWorkspaceResults()).toEqual([]);
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
        expect(
          failure,
          JSON.stringify(
            liveRequests.map(({ seq, lastAckedSeq, event }) => ({
              seq,
              lastAckedSeq,
              event: event.kind === "lifecycle" ? event : { kind: event.kind },
            })),
          ),
        ).toBeUndefined();
        const finishing = liveRequests.filter(
          ({ event }) => event.kind === "lifecycle" && event.payload.phase === "finishing",
        );
        expect(finishing.length).toBeGreaterThan(0);
        expect(finishing.at(-1)?.event).toMatchObject({
          kind: "lifecycle",
          payload: { phase: "finishing", aborted: true, stopReason: "aborted" },
        });
        expect(harness.placementStore.get(SESSION_ID)?.lastLiveEventAckCursor).toBe(
          finishing.at(-1)?.seq,
        );
        expect(JSON.parse(stdout)).toMatchObject({
          type: "result",
          turnId: descriptor.assignment.turnId,
          retainWorker: false,
          result: { status: "failed", reason: "turn-failed" },
        });
      } catch (error) {
        failureTrace = captureTrace();
        throw error;
      } finally {
        previewGate?.release.resolve();
        finishingGate.release.resolve();
        previewRelease.resolve();
        providerRelease.resolve(doneOutcome("fixture teardown"));
        lifetimeController.abort(new Error("fixture teardown"));
        input.end();
        await Promise.allSettled([command]);
        owner.signal.removeEventListener("abort", cancelWorker);
        owner.dispose();
        registration.cleanup();
        unsubscribe();
        if (previousConfig) {
          setRuntimeConfigSnapshot(previousConfig, previousSourceConfig ?? undefined);
        } else {
          clearRuntimeConfigSnapshot();
        }
      }
    },
  );
});
