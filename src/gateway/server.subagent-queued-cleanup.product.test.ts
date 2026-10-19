// Prove queued subagent Stop cleanup through real model, ingress, and control boundaries.
import { X509Certificate } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
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
  // The local provider emits the same streamed function-call sequence consumed by
  // the OpenAI Responses adapter. Production runner code then owns tool execution.
  const sequence = ++responseSequence;
  const responseId = `resp_queued_cleanup_${sequence}`;
  const itemId = `fc_queued_cleanup_${sequence}`;
  const callId = `call_queued_cleanup_${sequence}`;
  const argumentsText = JSON.stringify(args);
  const item = {
    type: "function_call",
    id: itemId,
    call_id: callId,
    name,
    arguments: argumentsText,
  };
  return [
    {
      type: "response.created",
      response: { id: responseId, object: "response", status: "in_progress", output: [] },
    },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      item_id: itemId,
      output_index: 0,
      delta: argumentsText,
    },
    {
      type: "response.function_call_arguments.done",
      item_id: itemId,
      output_index: 0,
      arguments: argumentsText,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [item],
        usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
      },
    },
  ];
}

function findSpawnReceipt(value: unknown): SpawnReceipt | undefined {
  // The external model transport sees the sessions_spawn result as nested request
  // input. Walk that public payload instead of inspecting the in-process registry.
  if (typeof value === "string") {
    try {
      return findSpawnReceipt(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const matched = findSpawnReceipt(item);
      if (matched) {
        return matched;
      }
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    if (
      "status" in value &&
      value.status === "accepted" &&
      "childSessionKey" in value &&
      typeof value.childSessionKey === "string" &&
      "runId" in value &&
      typeof value.runId === "string"
    ) {
      return { childSessionKey: value.childSessionKey, runId: value.runId };
    }
    for (const item of Object.values(value)) {
      const matched = findSpawnReceipt(item);
      if (matched) {
        return matched;
      }
    }
  }
  return undefined;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  }
  return body;
}

async function startYieldModelServer(allowYield: Promise<void>) {
  // Parent requests spawn the child. The child's first request stays open until
  // ingress has queued a follow-up, then returns a real sessions_yield tool call.
  const childAccepted = createDeferred<SpawnReceipt>();
  const childModelStarted = createDeferred();
  let yieldSent = false;
  let queuedInputRequests = 0;
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
      }
      response.end(JSON.stringify({ error: { message: String(error) } }));
    });
  });
  async function handleRequest(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "stop-proof", object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    const body = await readRequestBody(request);
    const parsed = JSON.parse(body) as unknown;
    if (body.includes(queuedInput)) {
      queuedInputRequests += 1;
    }
    // A fresh child attempt is the only request carrying the child task without a
    // prior tool result. Holding it keeps the admitted run available to ingress.
    if (body.includes(childTask) && !body.includes("function_call_output")) {
      childModelStarted.resolve();
      await allowYield;
      yieldSent = true;
      writeOpenAiResponsesSse(response, toolCallEvents("sessions_yield", { waitFor: "message" }));
      return;
    }
    // The parent uses the production sessions_spawn tool; its next provider request
    // carries the accepted child key in the function output below.
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
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    childAccepted: childAccepted.promise,
    childModelStarted: childModelStarted.promise,
    hasSentYield: () => yieldSent,
    queuedInputRequests: () => queuedInputRequests,
    url: `http://127.0.0.1:${address.port}/v1`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
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
      // Create the child through chat.send and discover its key only from the model
      // transport response to sessions_spawn.
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

      // Real channel ingress claims durable custody, then the reply runner defers the
      // input as a follow-up behind the active child turn.
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
              ChatType: "direct",
              From: "user:queued-cleanup",
              To: "channel:queued-cleanup",
              SessionKey: event.payload.text,
              MessageSid: event.id,
              Body: queuedInput,
              CommandBody: queuedInput,
              BodyForAgent: queuedInput,
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

      // sessions_yield settles the operation but deliberately leaves the subagent
      // task nonterminal, making public Stop responsible for the queued input.
      allowYield.resolve();
      await childTerminal.promise;
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      stopResponse = postSubagentKill(gateway.port, childSessionKey);
      await releaseStarted.promise;
      // Durable kill writes can finish after ingress release starts. Advance only
      // once the real source-cleanup owner has armed its drain deadline.
      await awaitGateBeforeSettlement(
        sourceDrainStarted.promise,
        stopResponse,
        "Stop responded before joining the held source cleanup",
      );
      await vi.advanceTimersByTimeAsync(SESSION_CONTROLLER_DRAIN_TIMEOUT_MS * 2 + 1);
      const settledResponse = await stopResponse;
      expect(settledResponse).toMatchObject({
        status: 503,
        body: {
          ok: false,
          error: { message: expect.stringMatching(/execution cleanup remains pending/i) },
        },
      });
      releaseCleanup.resolve();
      await releaseFinished.promise;
      // Once cleanup releases custody, repeated Stop observes the same durable
      // cancellation without killing the run again or dispatching its held queued input.
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
    async () => {
      if (stopResponse) {
        await stopResponse.catch(() => undefined);
      }
    },
    () => sourceDrainSpy.mockRestore(),
    () => drain?.dispose(),
    () => disconnectGatewayClient(gateway.client),
    async () => {
      await gateway.server.close({ reason: "subagent yielded queued cleanup complete" });
    },
    () => model.close(),
    () => state.cleanup(),
  );
  expect(model.queuedInputRequests()).toBe(0);
});
