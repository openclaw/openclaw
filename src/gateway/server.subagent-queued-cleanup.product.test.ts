import { text } from "node:stream/consumers";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { startOpenAiResponsesModelServer } from "../../test/helpers/openai-responses-model-fixture.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { dispatchReplyWithBufferedBlockDispatcherCore } from "../auto-reply/reply/provider-dispatcher.js";
import { buildTestCtx } from "../auto-reply/reply/test-ctx.js";
import {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressDrain,
} from "../channels/message/ingress-drain.js";
import {
  createTestIngressQueue,
  observeChannelIngressQueueWrite,
} from "../channels/message/ingress-drain.test-helpers.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import {
  createSubagentStopFixture,
  findSubagentSpawnReceipt,
  postSubagentKill,
  subagentToolCallEvents,
  type KillResponse,
  type SpawnReceipt,
} from "./server.subagent-stop-settlement.product.test-support.js";
import { disconnectGatewayClient } from "./test-helpers.e2e.js";

const parentPrompt = "Spawn the child that will yield.";
const childTask = "Pause this unfinished task until an incoming continuation arrives.";
const queuedInput = "Queued durable child input";
afterEach(async () => {
  await resetSubagentRegistryForTests({ persist: false });
});

it("bounds public child Stop while yielded queued-input cleanup remains pending", async () => {
  const allowYield = createDeferred();
  const childAccepted = createDeferred<SpawnReceipt>();
  const childModelStarted = createDeferred();
  let yieldSent = false;
  let queuedInputRequests = 0;
  let responseSequence = 0;
  const model = await startOpenAiResponsesModelServer({
    modelId: "stop-proof",
    bindError: "Expected queued cleanup model server address",
    onRequest: async (request, response) => {
      const body = await text(request);
      const parsed = JSON.parse(body) as unknown;
      if (body.includes(queuedInput)) {
        queuedInputRequests += 1;
        writeOpenAiResponsesText(response, {
          text: "Queued input processed.",
          responseId: `response-${++responseSequence}`,
          messageId: `message-${responseSequence}`,
        });
        return;
      }
      // Only the fresh child attempt carries its task without a prior tool result.
      if (body.includes(childTask) && !body.includes("function_call_output")) {
        childModelStarted.resolve();
        await allowYield.promise;
        yieldSent = true;
        writeOpenAiResponsesSse(
          response,
          subagentToolCallEvents("sessions_yield", { waitFor: "message" }, ++responseSequence),
        );
        return;
      }
      // The parent's next request carries the accepted child key in its tool output.
      if (body.includes(parentPrompt) && !body.includes("function_call_output")) {
        writeOpenAiResponsesSse(
          response,
          subagentToolCallEvents(
            "sessions_spawn",
            { task: childTask, context: "isolated" },
            ++responseSequence,
          ),
        );
        return;
      }
      const receipt = findSubagentSpawnReceipt(parsed);
      if (receipt) {
        childAccepted.resolve(receipt);
      }
      writeOpenAiResponsesText(response, {
        text: body.includes(childTask) ? "NO_REPLY" : "Child accepted.",
        responseId: `response-${++responseSequence}`,
        messageId: `message-${responseSequence}`,
      });
    },
  });
  const { state, cfg, start } = await createSubagentStopFixture(
    "subagent-yielded-queued-cleanup",
    `${model.baseUrl}/v1`,
  );
  cfg.messages = { queue: { mode: "followup" } };
  const childTerminal = createDeferred();
  let childSessionKey: string | undefined;
  let gateway = await start((event) => {
    const payload = event.payload as { sessionKey?: unknown; state?: unknown } | undefined;
    if (
      event.event === "chat" &&
      payload &&
      payload.sessionKey === childSessionKey &&
      yieldSent &&
      ["aborted", "error", "final"].includes(String(payload.state))
    ) {
      childTerminal.resolve();
    }
  });
  const releaseCleanup = createDeferred();
  const releaseStarted = createDeferred();
  const releaseFinished = createDeferred();
  let releaseCommitted = false;
  let stopResponse: Promise<KillResponse> | undefined;
  let drain: ReturnType<typeof createChannelIngressDrain> | undefined;
  await runQaGatewayFixture(
    async () => {
      await gateway.server.startupSettled;
      const parentRunId = "subagent-yielded-queued-cleanup-parent";
      await expect(
        gateway.client.request("chat.send", {
          sessionKey: "agent:main:subagent-yielded-queued-cleanup-parent",
          message: parentPrompt,
          idempotencyKey: parentRunId,
          deliver: false,
        }),
      ).resolves.toMatchObject({ runId: parentRunId, status: "started" });
      const child = await childAccepted.promise;
      childSessionKey = child.childSessionKey;
      await childModelStarted.promise;

      // Keep real ingress custody while the reply runner defers behind the child.
      const queue = createTestIngressQueue(state.stateDir);
      const eventId = "queued-child-input";
      const receivedAt = Date.now() - 25 * 60 * 60_000;
      await queue.enqueue(eventId, { text: queuedInput }, { laneKey: childSessionKey, receivedAt });
      for (let attempt = 0; attempt < 7; attempt++) {
        const claim = expectDefined(await queue.claim(eventId), "seeded retry claim");
        await queue.release(claim, {
          lastError: "previous delivery failed",
          releasedAt: receivedAt + attempt + 1,
        });
      }
      const release = queue.release.bind(queue);
      queue.release = async (...args) => {
        releaseStarted.resolve();
        await releaseCleanup.promise;
        try {
          releaseCommitted = await release(...args);
          return releaseCommitted;
        } finally {
          releaseFinished.resolve();
        }
      };
      let deferredMode: "followup" | "steer" | undefined;
      const startDrain = (source: typeof queue) =>
        createChannelIngressDrain({
          queue: source,
          dispatchClaimedEvent: async (event, lifecycle) => {
            const result = await dispatchReplyWithBufferedBlockDispatcherCore({
              ctx: buildTestCtx({
                AgentId: "main",
                Provider: "test",
                Surface: "test",
                From: "user:queued-cleanup",
                To: "channel:queued-cleanup",
                SessionKey: expectDefined(event.laneKey, "queued session key"),
                MessageSid: event.id,
                Body: event.payload.text,
                CommandBody: event.payload.text,
              }),
              cfg,
              dispatcherOptions: { deliver: async () => undefined },
              replyOptions: bindIngressLifecycleToReplyOptions(lifecycle),
            });
            deferredMode = result.deferredToActiveRun;
            return result.deferredToActiveRun ? { kind: "deferred" } : { kind: "completed" };
          },
        });
      drain = startDrain(queue);
      await expect(drain.drainOnce()).resolves.toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(deferredMode).toBe("followup");
      await expect(queue.listClaims()).resolves.toHaveLength(1);

      allowYield.resolve();
      await childTerminal.promise;
      const failed = observeChannelIngressQueueWrite(queue, "fail", eventId);
      stopResponse = postSubagentKill(gateway.port, childSessionKey);
      expect(
        await Promise.race([
          releaseStarted.promise.then(() => "release"),
          failed.then(() => "dead-letter"),
        ]),
      ).toBe("release");
      expect(await stopResponse).toMatchObject({
        status: 503,
        body: {
          ok: false,
          error: { message: expect.stringMatching(/execution cleanup remains pending/i) },
        },
      });
      releaseCleanup.resolve();
      await releaseFinished.promise;
      // Repeated Stop observes durable cancellation without dispatching queued input.
      const retry = await postSubagentKill(gateway.port, childSessionKey);
      expect(retry, JSON.stringify(retry)).toEqual({
        status: 200,
        body: { ok: true, killed: false },
      });
      const persisted = await executeExistingOpenClawStateRead(
        { env: state.env },
        { type: "subagents.runs", scope: { kind: "ids", runIds: [child.runId] } },
      );
      if (!persisted || persisted.projection === "maintenance") {
        throw new Error("Expected the complete persisted subagent run");
      }
      const stopped = persisted.runs.get(child.runId);
      expect(stopped).toMatchObject({
        runId: child.runId,
        childSessionKey: child.childSessionKey,
        endedReason: "subagent-killed",
        execution: { status: "terminal" },
      });
      expect(stopped?.pauseReason).toBeUndefined();
      expect(releaseCommitted).toBe(true);
      await expect(queue.listClaims()).resolves.toEqual([]);
      // Unadopted ingress remains durable for a later, freshly admitted attempt.
      await expect(queue.listPending()).resolves.toEqual([
        expect.objectContaining({
          id: "queued-child-input",
          attempts: 7,
          payload: { text: queuedInput },
        }),
      ]);
      expect(queuedInputRequests).toBe(0);
      drain.dispose();
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close({ reason: "verify durable replay" });
      gateway = await start();
      await gateway.server.startupSettled;
      const reopened = createTestIngressQueue(state.stateDir);
      const pendingAfterRestart = await reopened.listPending();
      expect(pendingAfterRestart).toMatchObject([{ id: eventId, attempts: 7 }]);
      drain = startDrain(reopened);
      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(await reopened.listPending()).toEqual([]);
      expect(await reopened.listClaims()).toEqual([]);
      expect(await reopened.listFailed?.()).toEqual([]);
      const receipt = await reopened.enqueue(eventId, { text: queuedInput });
      expect(receipt.kind).toBe("completed");
      expect(queuedInputRequests).toBe(1);
      console.log("Gateway Stop/restart replay", {
        pendingAttemptsAfterRestart: pendingAfterRestart[0]?.attempts,
        replayReceipt: receipt.kind,
        replayModelRequests: queuedInputRequests,
      });
    },
    () => releaseCleanup.resolve(),
    () => stopResponse?.catch(() => undefined),
    () => drain?.dispose(),
    () => disconnectGatewayClient(gateway.client),
    () => gateway.server.close({ reason: "subagent yielded queued cleanup complete" }),
    () => model.close(),
    () => state.cleanup(),
  );
});
