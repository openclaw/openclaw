import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, expect, it } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closeProvider,
  listenProvider,
  readProviderBody,
  writeToolCall,
} from "./gateway-provider-fixture.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const opsPrompt = "Keep the operations turn active while research finishes.";
const parentPrompt = "Spawn the research child now.";
const childTask = "Return the isolated research result.";
const childResult = "RESEARCH_CHILD_RESULT_7d61b2";

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
  const reply = (response: ServerResponse, text: string, id: string) =>
    writeOpenAiResponsesText(response, { text, messageId: id, responseId: `${id}_response` });
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
    const body = await readProviderBody(request);
    requests.push(body);
    // Hold the peer turn at the provider so requester activity overlaps deterministically.
    if (body.includes(opsPrompt)) {
      if (++opsRequests === 1) {
        opsStarted.resolve();
        await releaseOps.promise;
      }
      reply(response, "Operations turn complete.", `ops_${opsRequests}`);
      return;
    }
    if (body.includes(parentPrompt)) {
      // A private completion returns to the same research transcript through a new agent turn.
      if (body.includes(childResult)) {
        reply(response, "NO_REPLY", "research_completion");
        return;
      }
      if (!body.includes("function_call_output")) {
        writeToolCall(
          response,
          "sessions_spawn",
          {
            task: childTask,
            context: "isolated",
            completionTarget: "parent",
            cleanup: "delete",
          },
          8,
          4,
        );
        return;
      }
      const childReceipt = findChildSpawnReceipt(JSON.parse(body) as unknown);
      if (childReceipt) {
        childAccepted.resolve(childReceipt);
      }
      reply(response, "Research child accepted.", "research_parent");
      return;
    }
    if (body.includes(childTask)) {
      // Finish the child only after the parent is idle and the peer agent is active.
      childStarted.resolve();
      await releaseChild.promise;
      reply(response, childResult, "research_child");
      return;
    }
    reply(response, "NO_REPLY", `fallback_${randomUUID()}`);
  }
  return {
    url: await listenProvider(server),
    opsStarted: opsStarted.promise,
    releaseOps: () => releaseOps.resolve(),
    childStarted: childStarted.promise,
    releaseChild: () => releaseChild.resolve(),
    childAccepted: childAccepted.promise,
    requests,
    close: () => closeProvider(server),
  };
}

function buildConfig(workspace: string, modelUrl: string): OpenClawConfig {
  const { config } = buildMockOpenAiResponsesProvider(modelUrl, "announce-owner");
  return {
    agents: {
      ownership: "explicit",
      entries: { ops: {}, research: {} },
      defaults: {
        workspace,
        skipBootstrap: true,
        model: { primary: "synthetic/announce-owner" },
        subagents: { allowAgents: ["*"] },
      },
    },
    session: { scope: "global" },
    models: {
      mode: "replace",
      providers: {
        synthetic: {
          ...config,
          agentRuntime: { id: "openclaw" },
          apiKey: "synthetic-test-key",
          request: { allowPrivateNetwork: true },
          models: [
            {
              ...config.models[0],
              name: "Announce owner",
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

afterEach(() => resetSubagentRegistryForTests({ persist: false }));

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
      if (event.event === "chat" && payload?.state === "final" && payload.runId === parentRunId) {
        parentTerminal.resolve();
      }
    },
  });
  const send = (agentId: string, message: string, idempotencyKey: string) =>
    gateway.client.request<{ runId: string }>("chat.send", {
      sessionKey: "global",
      agentId,
      message,
      idempotencyKey,
      deliver: false,
    });
  const wait = (runId: string) =>
    expect(
      gateway.client.request("agent.wait", { runId, timeoutMs: 30_000 }),
    ).resolves.toMatchObject({
      status: "ok",
    });
  try {
    await gateway.server.startupSettled;
    await gateway.client.request("sessions.subscribe", {});
    // Establish the research requester and its private child through public Gateway ingress.
    const parentAccepted = await send("research", parentPrompt, parentRunId);
    expect(parentAccepted.runId).toBe(parentRunId);
    await model.childStarted;
    const child = await model.childAccepted;
    childSessionKey = child.childSessionKey;
    await parentTerminal.promise;

    // Keep a different agent's identical bare key active while the child completes.
    const opsAccepted = await send("ops", opsPrompt, "announce-owner-ops");
    await model.opsStarted;

    model.releaseChild();
    await wait(child.runId);
    await childDeleted.promise;

    // The deletion event fences completion delivery before either destination is inspected.
    const researchRequests = model.requests.filter((body) => body.includes(parentPrompt));
    expect(researchRequests.some((body) => body.includes(childResult))).toBe(true);
    model.releaseOps();
    await wait(opsAccepted.runId);
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
