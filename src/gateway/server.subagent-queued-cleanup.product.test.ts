import { X509Certificate } from "node:crypto";
import { text } from "node:stream/consumers";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { startOpenAiResponsesModelServer } from "../../test/helpers/openai-responses-model-fixture.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import * as subagentKillSettlement from "../agents/subagents/registry/subagent-control-kill-settlement.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { dispatchReplyWithBufferedBlockDispatcherCore } from "../auto-reply/reply/provider-dispatcher.js";
import { buildTestCtx } from "../auto-reply/reply/test-ctx.js";
import {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressDrain,
} from "../channels/message/ingress-drain.js";
import { createTestIngressQueue } from "../channels/message/ingress-drain.test-helpers.js";
import { SESSION_CONTROLLER_DRAIN_TIMEOUT_MS } from "../sessions/session-controller.lifecycle.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  buildSubagentStopConfig,
  postSubagentKill,
  subagentStopProxyHeaders,
  type KillResponse,
  type SpawnReceipt,
} from "./server.subagent-stop-settlement.product.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

const proxyUser = "subagent-stop-administrator@example.test";
const parentPrompt = "Spawn the child that will yield.";
const childTask = "Pause this unfinished task until an incoming continuation arrives.";
const queuedInput = "Queued durable child input";
let responseSequence = 0;

function toolCallEvents(name: string, args: Record<string, unknown>) {
  // Preserve the streamed call sequence; the real runner executes the tools.
  const sequence = ++responseSequence;
  const itemId = `fc_queued_cleanup_${sequence}`;
  const argumentsText = JSON.stringify(args);
  const item = {
    type: "function_call",
    id: itemId,
    call_id: `call_queued_cleanup_${sequence}`,
    name,
    arguments: argumentsText,
  };
  const response = { id: `resp_queued_cleanup_${sequence}`, object: "response" };
  const argumentEvent = (type: string, data: Record<string, unknown>) => ({
    type: `response.function_call_arguments.${type}`,
    item_id: itemId,
    output_index: 0,
    ...data,
  });
  return [
    {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    argumentEvent("delta", { delta: argumentsText }),
    argumentEvent("done", { arguments: argumentsText }),
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        ...response,
        status: "completed",
        output: [item],
        usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
      },
    },
  ];
}

function findSpawnReceipt(value: unknown): SpawnReceipt | undefined {
  // Read the public sessions_spawn result, never the in-process registry.
  if (typeof value === "string") {
    try {
      return findSpawnReceipt(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }
  if (isRecord(value) || Array.isArray(value)) {
    if (
      isRecord(value) &&
      value.status === "accepted" &&
      typeof value.childSessionKey === "string" &&
      typeof value.runId === "string"
    ) {
      return { childSessionKey: value.childSessionKey, runId: value.runId };
    }
    for (const item of Array.isArray(value) ? value : Object.values(value)) {
      const matched = findSpawnReceipt(item);
      if (matched) {
        return matched;
      }
    }
  }
  return undefined;
}

async function startYieldModelServer(allowYield: Promise<void>) {
  const childAccepted = createDeferred<SpawnReceipt>();
  const childModelStarted = createDeferred();
  let yieldSent = false;
  let queuedInputRequests = 0;
  const server = await startOpenAiResponsesModelServer({
    modelId: "stop-proof",
    bindError: "Expected queued cleanup model server address",
    onRequest: async (request, response) => {
      const body = await text(request);
      const parsed = JSON.parse(body) as unknown;
      if (body.includes(queuedInput)) {
        queuedInputRequests += 1;
      }
      // Only the fresh child attempt carries its task without a prior tool result.
      if (body.includes(childTask) && !body.includes("function_call_output")) {
        childModelStarted.resolve();
        await allowYield;
        yieldSent = true;
        writeOpenAiResponsesSse(response, toolCallEvents("sessions_yield", { waitFor: "message" }));
        return;
      }
      // The parent's next request carries the accepted child key in its tool output.
      if (body.includes(parentPrompt) && !body.includes("function_call_output")) {
        writeOpenAiResponsesSse(
          response,
          toolCallEvents("sessions_spawn", { task: childTask, context: "isolated" }),
        );
        return;
      }
      const receipt = findSpawnReceipt(parsed);
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
  return {
    childAccepted: childAccepted.promise,
    childModelStarted: childModelStarted.promise,
    hasSentYield: () => yieldSent,
    queuedInputRequests: () => queuedInputRequests,
    url: `${server.baseUrl}/v1`,
    close: server.close,
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await resetSubagentRegistryForTests({ persist: false });
});

it("bounds public child Stop while yielded queued-input cleanup remains pending", async () => {
  const allowYield = createDeferred();
  const model = await startYieldModelServer(allowYield.promise);
  const state = await createOpenClawTestState({ label: "subagent-yielded-queued-cleanup" });
  setUserProfileRole(ensureProfileForEmail(proxyUser).id, "administrator");
  const cfg = buildSubagentStopConfig(state.workspaceDir, {
    certPath: await state.writeText("tls/cert.pem", TEST_TLS_CERT_PEM),
    keyPath: await state.writeText("tls/key.pem", TEST_TLS_KEY_PEM),
  });
  const provider = cfg.models?.providers?.synthetic;
  if (!provider) {
    throw new Error("Missing synthetic model provider");
  }
  provider.baseUrl = model.url;
  provider.request = { allowPrivateNetwork: true };
  cfg.messages = { queue: { mode: "followup" } };
  const childTerminal = createDeferred();
  let childSessionKey: string | undefined;
  const gateway = await startGatewayWithClient({
    cfg,
    configPath: state.configPath,
    auth: cfg.gateway?.auth,
    edgeAuthHeaders: subagentStopProxyHeaders,
    secure: true,
    tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
    clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
    mode: GATEWAY_CLIENT_MODES.WEBCHAT,
    origin: "https://control.example.com",
    scopes: ["operator.admin", "operator.read", "operator.write"],
    onEvent: (event) => {
      const payload = event.payload as { sessionKey?: unknown; state?: unknown } | undefined;
      if (
        event.event === "chat" &&
        payload &&
        payload.sessionKey === childSessionKey &&
        model.hasSentYield() &&
        ["aborted", "error", "final"].includes(String(payload.state))
      ) {
        childTerminal.resolve();
      }
    },
  });
  const releaseCleanup = createDeferred();
  const releaseStarted = createDeferred();
  const releaseFinished = createDeferred();
  const sourceDrainStarted = createDeferred();
  let releaseCommitted = false;
  let stopResponse: Promise<KillResponse> | undefined;
  let drain: ReturnType<typeof createChannelIngressDrain> | undefined;
  const settleSources = subagentKillSettlement.settleSubagentKillSources;
  const sourceDrainSpy = vi
    .spyOn(subagentKillSettlement, "settleSubagentKillSources")
    .mockImplementation((params) => {
      const pending = settleSources(params);
      if (
        childSessionKey !== undefined &&
        params.cleanup?.inputs.some((input) => input.target?.sessionKey === childSessionKey)
      ) {
        sourceDrainStarted.resolve();
      }
      return pending;
    });
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
      const child = await model.childAccepted;
      childSessionKey = child.childSessionKey;
      await model.childModelStarted;

      // Keep real ingress custody while the reply runner defers behind the child.
      const queue = createTestIngressQueue(state.stateDir);
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
      drain = createChannelIngressDrain({
        queue,
        dispatchClaimedEvent: async (event, lifecycle) => {
          const result = await dispatchReplyWithBufferedBlockDispatcherCore({
            ctx: buildTestCtx({
              AgentId: "main",
              Provider: "test",
              Surface: "test",
              From: "user:queued-cleanup",
              To: "channel:queued-cleanup",
              SessionKey: event.payload.text,
              MessageSid: event.id,
              Body: queuedInput,
              CommandBody: queuedInput,
            }),
            cfg,
            dispatcherOptions: { deliver: async () => undefined },
            replyOptions: bindIngressLifecycleToReplyOptions(lifecycle),
          });
          deferredMode = result.deferredToActiveRun;
          return result.deferredToActiveRun ? { kind: "deferred" } : { kind: "completed" };
        },
      });
      await queue.enqueue(
        "queued-child-input",
        { text: childSessionKey },
        { laneKey: childSessionKey },
      );
      await expect(drain.drainOnce()).resolves.toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(deferredMode).toBe("followup");
      await expect(queue.listClaims()).resolves.toHaveLength(1);

      allowYield.resolve();
      await childTerminal.promise;
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      stopResponse = postSubagentKill(gateway.port, childSessionKey);
      await releaseStarted.promise;
      // Advance only after the real source owner arms its cleanup deadline.
      await awaitGateBeforeSettlement(
        sourceDrainStarted.promise,
        stopResponse,
        "Stop responded before joining the held source cleanup",
      );
      await vi.advanceTimersByTimeAsync(SESSION_CONTROLLER_DRAIN_TIMEOUT_MS * 2 + 1);
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
          payload: { text: child.childSessionKey },
        }),
      ]);
    },
    () => releaseCleanup.resolve(),
    () => stopResponse?.catch(() => undefined),
    () => sourceDrainSpy.mockRestore(),
    () => drain?.dispose(),
    () => disconnectGatewayClient(gateway.client),
    () => gateway.server.close({ reason: "subagent yielded queued cleanup complete" }),
    () => model.close(),
    () => state.cleanup(),
  );
  expect(model.queuedInputRequests()).toBe(0);
});
