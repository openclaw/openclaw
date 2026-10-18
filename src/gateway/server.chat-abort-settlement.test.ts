import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { closeGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { InternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import { readReplySourceInput } from "../auto-reply/reply/reply-source-binding.js";
import { clearConfigCache } from "../config/config.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { createReplyOperation } from "../sessions/session-controller.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import { retireSessionControllerInput } from "../sessions/session-controller.mailbox.js";
import { observeGatewayRunExecution } from "./agent-command.test-helpers.js";
import { observeGatewayConnectionWork } from "./server-held-work.test-support.js";
import {
  createQueuedFollowupFixtureForTest,
  settleQueuedFollowupRunForTest,
} from "./server-methods/queued-followup-fixtures.test-support.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import { releaseGatewaySessionStoreFixture } from "./test/server-sessions-resources.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const temporaryDirectories = useAutoCleanupTempDirTracker(afterEach);
type GatewayHarness = Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
type GatewaySocket = Awaited<ReturnType<GatewayHarness["openWs"]>>;
let gateway: GatewayHarness;
const connectionReleases: Promise<void>[] = [];
let restoreConnectionObserver: (() => void) | undefined;
type ObservedConnection = Awaited<ReturnType<typeof observeGatewayConnectionWork>>;
let gatewayContext: NonNullable<ObservedConnection["context"]>;

function trackChatTerminalStates(socket: GatewaySocket, runId: string): string[] {
  const terminalStates: string[] = [];
  socket.on("message", (raw) => {
    const frame = JSON.parse(rawDataToString(raw)) as Awaited<ReturnType<typeof onceMessage>>;
    if (
      frame.type === "event" &&
      frame.event === "chat" &&
      frame.payload?.runId === runId &&
      typeof frame.payload.state === "string"
    ) {
      terminalStates.push(frame.payload.state);
    }
  });
  return terminalStates;
}

beforeAll(async () => {
  const observer = await observeGatewayConnectionWork(connectionReleases);
  restoreConnectionObserver = observer.restore;
  try {
    gateway = await createGatewaySuiteHarness();
    gatewayContext = expectDefined(observer.context, "Gateway fixture context");
  } finally {
    observer.stopCapture();
  }
});

afterAll(async () => {
  await gateway.close();
  restoreConnectionObserver?.();
});

afterEach(async () => {
  await runQaGatewayFixture(
    async () => {
      for (const dir of temporaryDirectories.dirs) {
        await releaseGatewaySessionStoreFixture(dir);
      }
    },
    () => {
      dispatchInboundMessageMock.mockReset();
      testState.sessionStorePath = undefined;
      clearConfigCache();
    },
  );
});

test.for([
  "fulfilled",
  "rejected",
  "queued-fulfilled",
  "queued-rejected",
  "queued-dispatch-settled",
  "accepted-injection",
] as const)(
  "preserves an acknowledged abort across %s dispatch settlement",
  async (settlement, { signal }) => {
    const sessionDirectory = temporaryDirectories.make("openclaw-chat-abort-dispatch-");
    testState.sessionStorePath = path.join(sessionDirectory, "sessions.json");
    await writeSessionStore({
      entries: { main: { sessionId: "sess-main", updatedAt: Date.now() } },
    });

    const agentJobs = await import("./agent-turn/agent-job.js");
    const connectionOffset = connectionReleases.length;
    const socket = await gateway.openWs();
    const requestExecution = await observeGatewayRunExecution();
    const [dispatchRelease, dispatchStarted, waitInstalled] = [
      createDeferred(),
      createDeferred(),
      createDeferred(),
    ];
    const runId = `real-websocket-explicit-abort-before-${settlement}-dispatch`;
    const wait = <T>(pending: PromiseLike<T>) => withinTest(pending, signal);
    const expectPayload = async (response: ReturnType<typeof rpcReq>, payload: unknown) => {
      const result = await wait(response);
      expect(result).toMatchObject({ ok: true, payload });
      return result;
    };
    const waitDispatch = () => wait(requestExecution.waitForDispatch(runId));
    const terminalStates = trackChatTerminalStates(socket, runId);
    const dispatches: Promise<unknown>[] = [];
    const frames: Promise<unknown>[] = [];
    const track = <T>(work: Promise<T>, pending = dispatches) => {
      pending.push(work);
      void work.catch(() => {});
      return work;
    };
    const rpc = (method: string, params: Record<string, unknown>) =>
      track(rpcReq(socket, method, params), frames);
    const agentWait = (timeoutMs = 0) => rpc("agent.wait", { runId, timeoutMs });
    let waitSettled = false;
    let queuedLifecycle: InternalGetReplyOptions["turnAdoptionLifecycle"];
    let queuedReply: InternalGetReplyOptions["onQueuedFollowupReplyBatch"];
    const queuedFixture = createQueuedFollowupFixtureForTest(testState.sessionStorePath);
    let queuedRun: ReturnType<typeof queuedFixture.bind> | undefined;
    let injectionOperation: ReturnType<typeof createReplyOperation> | undefined;
    let injectionSignal: AbortSignal | undefined;
    let injectionSettled = false;
    const injectionWork: Promise<void>[] = [];
    const waitForAgentJob = agentJobs.waitForAgentJob;
    const waitObserver = vi.spyOn(agentJobs, "waitForAgentJob").mockImplementation((params) => {
      const work = waitForAgentJob(params);
      if (params.runId === runId) {
        track(work, frames);
        const settled = () => {
          waitSettled = true;
        };
        void work.then(settled, settled);
        // The real owner installs its waiter synchronously before returning this promise.
        waitInstalled.resolve();
      }
      return work;
    });

    try {
      await connectOk(socket);
      if (settlement === "accepted-injection") {
        injectionOperation = createReplyOperation({
          sessionKey: "agent:main:main",
          sessionId: "sess-main",
          target: captureSessionTarget({
            storeScope: testState.sessionStorePath!,
            sessionKey: "agent:main:main",
            incarnation: "sess-main",
            agentId: "main",
          }),
          resetTriggered: false,
        });
        bindGatewayContextResolver(injectionOperation, gatewayContext.resolveGatewayContext);
        const fingerprint = "accepted-steer-tools";
        const { bindSteeringTools } =
          await import("./server-methods/chat-send-authority.test-support.js");
        bindSteeringTools(injectionOperation, fingerprint);
        injectionOperation.setPhase("running");
        injectionOperation.attachBackend({
          kind: "embedded",
          supportsTranscriptCommitWait: true,
          runId: "accepted-steer-backing-run",
          toolAuthorityFingerprint: fingerprint,
          cancel: () => {},
          messageInjectionV2: {
            version: 2,
            isAvailable: () => true,
            queueMessage: (_text, options, assertCurrent) => {
              assertCurrent();
              injectionSignal = options?.abortSignal;
              options?.onQueueAccepted?.(true);
              const work = dispatchRelease.promise.then(() => {
                injectionSettled = true;
              });
              injectionWork.push(work);
              return track(work);
            },
          },
        });
      } else {
        dispatchInboundMessageMock.mockImplementationOnce((args: unknown) => {
          return track(
            (async () => {
              if (settlement.startsWith("queued-")) {
                const options = (args as { replyOptions?: InternalGetReplyOptions }).replyOptions;
                queuedLifecycle = options?.turnAdoptionLifecycle;
                queuedReply = options?.onQueuedFollowupReplyBatch;
              }
              dispatchStarted.resolve();
              await dispatchRelease.promise;
              if (settlement.endsWith("rejected")) {
                throw new Error("dispatch rejected after an explicitly aborted run");
              }
              return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
            })(),
          );
        });
      }

      const sendParameters = {
        sessionKey: "main",
        message: "abort this dispatched message",
        idempotencyKey: runId,
        ...(settlement === "accepted-injection" ? { queueMode: "steer" } : {}),
      };
      await expectPayload(rpc("chat.send", sendParameters), { runId, status: "started" });
      if (settlement === "accepted-injection") {
        expect(injectionWork).toHaveLength(1);
        expect(injectionSignal?.aborted).toBe(false);
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      } else {
        await wait(dispatchStarted.promise);
        expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
      }

      if (settlement === "queued-dispatch-settled") {
        queuedRun = queuedFixture.bind(queuedLifecycle, "abort this dispatched message");
        dispatchRelease.resolve();
        await waitDispatch();
        await expectPayload(agentWait(), { runId, status: "pending", timeoutPhase: "queue" });
        expect(terminalStates).toEqual([]);
      }

      // Hold the wait deadline while real abort and persistence work establishes ordering.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let waitResponse = settlement === "queued-dispatch-settled" ? undefined : agentWait(2_000);
      if (waitResponse) {
        await wait(waitInstalled.promise);
      }
      if (settlement === "accepted-injection") {
        // Direct native acceptance retains a terminal wait; it is not a queued follow-up.
        expect({ waitSettled, terminalStates }).toEqual({ waitSettled: false, terminalStates: [] });
      }
      if (waitResponse && settlement.startsWith("queued-")) {
        queuedRun = queuedFixture.bind(queuedLifecycle, "abort this dispatched message");
        await expectPayload(waitResponse, {
          runId,
          status: "pending",
          timeoutPhase: "queue",
          providerStarted: false,
        });
        expect(terminalStates).toEqual([]);
        waitResponse = undefined;
      }
      const abortedFrame = track(
        onceMessage(
          socket,
          (frame) =>
            frame.type === "event" &&
            frame.event === "chat" &&
            frame.payload?.runId === runId &&
            frame.payload?.state === "aborted",
          2_000,
        ),
        frames,
      );
      await expectPayload(rpc("chat.abort", { sessionKey: "main", runId }), {
        ok: true,
        aborted: true,
        runIds: [runId],
      });
      await expect(wait(abortedFrame)).resolves.toMatchObject({
        payload: { runId, state: "aborted" },
      });
      if (settlement.startsWith("queued-")) {
        expect(queuedLifecycle?.abortSignal?.aborted).toBe(true);
        await expect(async () => queuedLifecycle?.onAdopted()).rejects.toBeDefined();
      } else if (settlement === "accepted-injection") {
        expect(injectionSignal?.aborted).toBe(true);
        expect(injectionSettled).toBe(false);
        dispatchRelease.resolve();
        await wait(Promise.all(injectionWork));
        expect(injectionSettled).toBe(true);
        await waitDispatch();
      } else {
        expect(waitSettled).toBe(false);
        dispatchRelease.resolve();
      }

      const terminalResponse = await expectPayload(waitResponse ?? agentWait(), {
        runId,
        status: "error",
        stopReason: "rpc",
        endedAt: expect.any(Number),
      });
      dispatchRelease.resolve();
      vi.useRealTimers();
      if (settlement !== "accepted-injection") {
        await waitDispatch();
      }
      await queuedLifecycle?.onSettled?.();
      await queuedReply?.({
        kind: "queued-followup",
        runId: "late-consumer-after-abort",
        originatingChannel: "webchat",
        payloads: [{ text: "must not resurrect the withdrawn input" }],
        completion: { kind: "completed" },
      });
      await expectPayload(agentWait(), terminalResponse.payload);

      // Replay can itself record an aborted receipt, so it must follow the original wait.
      // It also orders any contradictory terminal frame before this cached response.
      await expectPayload(rpc("chat.send", sendParameters), {
        runId,
        status: "timeout",
        summary: "aborted",
      });
      expect(terminalStates).toEqual(["aborted"]);
    } finally {
      vi.useRealTimers();
      dispatchRelease.resolve();
      await runQaGatewayFixture(
        () => closeGatewayTestWebSocket(socket),
        async () => {
          await Promise.allSettled(dispatches);
          const input = readReplySourceInput({ turnAdoptionLifecycle: queuedLifecycle });
          if (input) {
            retireSessionControllerInput(input);
          }
          if (queuedRun) {
            await settleQueuedFollowupRunForTest(queuedRun);
          }
          await queuedLifecycle?.onSettled?.();
          await Promise.allSettled([...frames, ...connectionReleases.slice(connectionOffset)]);
        },
        () => injectionOperation?.complete(),
        () => waitObserver.mockRestore(),
        () => requestExecution.restore(),
      );
    }
  },
);
