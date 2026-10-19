import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

const opsPrompt = "Keep the operations turn active while research finishes.";
const parentPrompt = "Spawn the research child now.";
const childTask = "Return the isolated research result.";
const childResult = "RESEARCH_CHILD_RESULT_7d61b2";

function toolCallEvents(name: string, args: Record<string, unknown>) {
  // Emit the complete Responses streaming sequence consumed by production tool dispatch.
  const responseId = `resp_${randomUUID()}`;
  const itemId = `fc_${randomUUID()}`;
  const callId = `call_${randomUUID()}`;
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

type ChildSpawnReceipt = { childSessionKey: string; runId: string };

function findChildSpawnReceipt(value: unknown): ChildSpawnReceipt | undefined {
  // The provider sees the production sessions_spawn result nested inside model input.
  if (typeof value === "string") {
    try {
      return findChildSpawnReceipt(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const matched = findChildSpawnReceipt(item);
      if (matched) {
        return matched;
      }
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.childSessionKey === "string" && typeof record.runId === "string") {
      return { childSessionKey: record.childSessionKey, runId: record.runId };
    }
    for (const item of Object.values(value)) {
      const matched = findChildSpawnReceipt(item);
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

async function startModelServer() {
  const opsStarted = createDeferred();
  const releaseOps = createDeferred();
  const childStarted = createDeferred();
  const releaseChild = createDeferred();
  const childAccepted = createDeferred<ChildSpawnReceipt>();
  const requests: string[] = [];
  let opsRequests = 0;
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : undefined);
    });
  });
  async function handleRequest(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "announce-owner", object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    const body = await readRequestBody(request);
    requests.push(body);
    // Hold the peer turn at the provider so requester activity overlaps deterministically.
    if (body.includes(opsPrompt)) {
      opsRequests += 1;
      if (opsRequests === 1) {
        opsStarted.resolve();
        await releaseOps.promise;
      }
      writeOpenAiResponsesText(response, {
        text: "Operations turn complete.",
        messageId: `ops_${opsRequests}`,
        responseId: `ops_response_${opsRequests}`,
      });
      return;
    }
    if (body.includes(parentPrompt)) {
      // A private completion returns to the same research transcript through a new agent turn.
      if (body.includes(childResult)) {
        writeOpenAiResponsesText(response, {
          text: "NO_REPLY",
          messageId: "research_completion",
          responseId: "research_completion_response",
        });
        return;
      }
      if (!body.includes("function_call_output")) {
        writeOpenAiResponsesSse(
          response,
          toolCallEvents("sessions_spawn", {
            task: childTask,
            context: "isolated",
            completionTarget: "parent",
            cleanup: "delete",
          }),
        );
        return;
      }
      const childReceipt = findChildSpawnReceipt(JSON.parse(body) as unknown);
      if (childReceipt) {
        childAccepted.resolve(childReceipt);
      }
      writeOpenAiResponsesText(response, {
        text: "Research child accepted.",
        messageId: "research_parent",
        responseId: "research_parent_response",
      });
      return;
    }
    if (body.includes(childTask)) {
      // Finish the child only after the parent is idle and the peer agent is active.
      childStarted.resolve();
      await releaseChild.promise;
      writeOpenAiResponsesText(response, {
        text: childResult,
        messageId: "research_child",
        responseId: "research_child_response",
      });
      return;
    }
    writeOpenAiResponsesText(response, {
      text: "NO_REPLY",
      messageId: `fallback_${randomUUID()}`,
      responseId: `fallback_response_${randomUUID()}`,
    });
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    opsStarted: opsStarted.promise,
    releaseOps: () => releaseOps.resolve(),
    childStarted: childStarted.promise,
    releaseChild: () => releaseChild.resolve(),
    childAccepted: childAccepted.promise,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function buildConfig(workspace: string, modelUrl: string): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      entries: { ops: {}, research: {} },
      defaults: {
        workspace,
        skipBootstrap: true,
        heartbeat: { every: "0m" },
        model: { primary: "synthetic/announce-owner" },
        subagents: { allowAgents: ["*"] },
      },
    },
    session: { scope: "global" },
    models: {
      mode: "replace",
      providers: {
        synthetic: {
          api: "openai-responses",
          agentRuntime: { id: "openclaw" },
          baseUrl: modelUrl,
          apiKey: "synthetic-test-key",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "announce-owner",
              name: "Announce owner",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 4096,
              maxTokens: 1024,
              agentRuntime: { id: "openclaw" },
              params: { transport: "sse", openaiWsWarmup: false },
            },
          ],
        },
      },
    },
    plugins: { enabled: false, slots: { memory: "none" } },
    tools: { profile: "coding", toolSearch: false },
    gateway: { controlUi: { enabled: false } },
  };
}

afterEach(async () => {
  await resetSubagentRegistryForTests({ persist: false });
});

it("delivers an idle requester's child completion to that requester while a peer global run is active", async () => {
  const model = await startModelServer();
  const state = await createOpenClawTestState({ label: "subagent-announce-agent-owner" });
  const childDeleted = createDeferred();
  const parentTerminal = createDeferred();
  const parentRunId = "announce-owner-research-parent";
  let childSessionKey: string | undefined;
  const gateway = await startGatewayWithClient({
    cfg: buildConfig(state.workspaceDir, model.url),
    configPath: state.configPath,
    token: "announce-owner-token",
    onEvent: (event) => {
      const payload = event.payload as
        | {
            reason?: unknown;
            runId?: unknown;
            sessionKey?: unknown;
            state?: unknown;
          }
        | undefined;
      if (
        event.event === "sessions.changed" &&
        payload?.reason === "delete" &&
        payload.sessionKey === childSessionKey
      ) {
        childDeleted.resolve();
      }
      if (event.event === "chat" && payload?.state === "final") {
        if (payload.runId === parentRunId) {
          parentTerminal.resolve();
        }
      }
    },
  });
  try {
    await gateway.server.startupSettled;
    await gateway.client.request("sessions.subscribe", {});
    // Establish the research requester and its private child through public Gateway ingress.
    const parentAccepted = await gateway.client.request<{ runId: string }>("chat.send", {
      sessionKey: "global",
      agentId: "research",
      message: parentPrompt,
      idempotencyKey: parentRunId,
      deliver: false,
    });
    expect(parentAccepted.runId).toBe(parentRunId);
    await model.childStarted;
    const child = await model.childAccepted;
    childSessionKey = child.childSessionKey;
    await parentTerminal.promise;

    // Keep a different agent's identical bare key active while the child completes.
    const opsAccepted = await gateway.client.request<{ runId: string }>("chat.send", {
      sessionKey: "global",
      agentId: "ops",
      message: opsPrompt,
      idempotencyKey: "announce-owner-ops",
      deliver: false,
    });
    await model.opsStarted;

    model.releaseChild();
    await expect(
      gateway.client.request("agent.wait", { runId: child.runId, timeoutMs: 30_000 }),
    ).resolves.toMatchObject({ status: "ok" });
    await childDeleted.promise;

    // The deletion event fences completion delivery before either destination is inspected.
    const researchRequests = model.requests.filter((body) => body.includes(parentPrompt));
    expect(researchRequests.some((body) => body.includes(childResult))).toBe(true);
    model.releaseOps();
    await expect(
      gateway.client.request("agent.wait", { runId: opsAccepted.runId, timeoutMs: 30_000 }),
    ).resolves.toMatchObject({ status: "ok" });
    const opsRequests = model.requests.filter((body) => body.includes(opsPrompt));
    expect(opsRequests.some((body) => body.includes(childResult))).toBe(false);
  } finally {
    model.releaseChild();
    model.releaseOps();
    await disconnectGatewayClient(gateway.client);
    await gateway.server.close({ reason: "subagent announce owner proof complete" });
    await model.close();
    await state.cleanup();
  }
});
