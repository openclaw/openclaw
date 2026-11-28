import { text } from "node:stream/consumers";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { startOpenAiResponsesModelServer } from "../../test/helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { dispatchReplyWithBufferedBlockDispatcherCore } from "../auto-reply/reply/provider-dispatcher.js";
import { buildTestCtx } from "../auto-reply/reply/test-ctx.js";
import {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressDrain,
} from "../channels/message/ingress-drain.js";
import { createTestIngressQueue } from "../channels/message/ingress-drain.test-helpers.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { patchSessionEntryWithKey } from "../config/sessions/session-accessor.js";
import { createSubagentStopFixture } from "./server.subagent-stop-settlement.product.test-support.js";
import { disconnectGatewayClient } from "./test-helpers.e2e.js";

it("retains an exhausted young followup and replies to the next input after a Gateway restart", async () => {
  const sessionKey = "agent:main:ingress-abandonment";
  const queuedText = "ingress-proof-queued-input";
  const nextText = "ingress-proof-next-input";
  const delivered: string[] = [];
  let nextRequests = 0;
  const modelStarted = createDeferred();
  const finishModel = createDeferred();
  let queuedRequests = 0;
  const model = await startOpenAiResponsesModelServer({
    modelId: "stop-proof",
    bindError: "Expected the synthetic model to bind locally",
    onRequest: async (request, response) => {
      const body = await text(request);
      const isNextInput = body.includes(nextText);
      if (isNextInput) {
        nextRequests++;
      }
      if (body.includes(queuedText)) {
        queuedRequests++;
      }
      modelStarted.resolve();
      await finishModel.promise;
      writeOpenAiResponsesText(response, {
        text: isNextInput ? "Next input received." : "Acknowledged.",
        responseId: isNextInput ? "resp_next_input" : "resp_ingress_proof",
        messageId: isNextInput ? "msg_next_input" : "msg_ingress_proof",
      });
    },
  });
  const { state, cfg, start } = await createSubagentStopFixture(
    "ingress-abandonment",
    `${model.baseUrl}/v1`,
  );
  cfg.messages = { queue: { mode: "followup" } };
  let gateway = await start();
  const queue = createTestIngressQueue(state.stateDir);
  let deferredMode: "steer" | "followup" | undefined;
  const startDrain = (ingressQueue: ReturnType<typeof createTestIngressQueue>) =>
    createChannelIngressDrain({
      queue: ingressQueue,
      dispatchClaimedEvent: async (event, lifecycle) => {
        const result = await dispatchReplyWithBufferedBlockDispatcherCore({
          ctx: buildTestCtx({
            AgentId: "main",
            Provider: "test",
            Surface: "test",
            From: "user:ingress",
            To: "channel:ingress",
            SessionKey: sessionKey,
            MessageSid: event.id,
            Body: event.payload.text,
            CommandBody: event.payload.text,
          }),
          cfg,
          dispatcherOptions: {
            deliver: async (payload, info) => {
              if (info.kind !== "tool" && payload.text) {
                delivered.push(payload.text);
              }
            },
          },
          replyOptions: bindIngressLifecycleToReplyOptions(lifecycle),
        });
        deferredMode = result.deferredToActiveRun;
        return result.deferredToActiveRun ? { kind: "deferred" } : { kind: "completed" };
      },
    });
  let drain = startDrain(queue);
  await runQaGatewayFixture(
    async () => {
      await gateway.server.startupSettled;
      await expect(
        gateway.client.request("chat.send", {
          sessionKey,
          message: "Hold the session",
          idempotencyKey: "hold-session",
          deliver: false,
        }),
      ).resolves.toMatchObject({ status: "started" });
      await modelStarted.promise;
      const receivedAt = Date.now() - 3 * 60_000;
      await queue.enqueue(
        "queued-input",
        { text: queuedText },
        { laneKey: sessionKey, receivedAt },
      );
      for (let attempt = 0; attempt < 7; attempt++) {
        const claim = expectDefined(await queue.claim("queued-input"), "prior claim");
        await queue.release(claim, {
          lastError: "turn-abandoned",
          releasedAt: receivedAt + attempt,
        });
      }
      expect(await queue.listPending()).toMatchObject([{ attempts: 7 }]);
      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(deferredMode).toBe("followup");
      expect(await queue.listClaims()).toMatchObject([{ id: "queued-input" }]);
      await queue.enqueue("next-input", { text: nextText }, { laneKey: sessionKey });
      // The target was archived while this attempt waited behind the active turn.
      const archivedAt = Date.now();
      const archived = await patchSessionEntryWithKey(
        {
          agentId: "main",
          sessionKey,
          storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
        },
        () => ({ archivedAt }),
      );
      expect(archived?.entry.archivedAt).toBe(archivedAt);
      finishModel.resolve();
      await vi.waitFor(async () => expect(await queue.listClaims()).toEqual([]), {
        timeout: 30_000,
      });
      const pending = await queue.listPending();
      const failed = await queue.listFailed?.();
      console.log("Gateway archived-destination retry outcome", {
        pending: pending.map(({ attempts, lastError }) => ({ attempts, lastError })),
        failed: failed?.map(({ reason, message }) => ({ reason, message })),
        queuedModelRequests: queuedRequests,
      });
      expect(pending.map((event) => event.id)).toEqual(["next-input"]);
      expect(failed).toMatchObject([
        {
          id: "queued-input",
          payload: { text: queuedText },
          reason: "retry-limit-exceeded",
          message: "turn-abandoned",
        },
      ]);
      expect(queuedRequests).toBe(0);
      // Restore the destination we deliberately archived to abandon the first followup.
      await gateway.client.request("sessions.patch", {
        key: sessionKey,
        archived: false,
        expectedSessionId: archived?.entry.sessionId,
      });
      drain.dispose();
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close({ reason: "verify same-lane recovery" });
      gateway = await start();
      await gateway.server.startupSettled;
      const reopened = createTestIngressQueue(state.stateDir);
      drain = startDrain(reopened);
      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(delivered).toEqual(["Next input received."]);
      expect(nextRequests).toBe(1);
      expect(await reopened.enqueue("next-input", { text: nextText })).toMatchObject({
        kind: "completed",
      });
      expect(await drain.drainOnce()).toEqual({ started: 0 });
    },
    () => finishModel.resolve(),
    () => drain.dispose(),
    () => disconnectGatewayClient(gateway.client),
    () => gateway.server.close({ reason: "ingress proof complete" }),
    () => model.close(),
    () => state.cleanup(),
  );
});
