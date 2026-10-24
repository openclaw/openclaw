import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, expect, it } from "vitest";
import { startOpenAiResponsesModelServer } from "../../test/helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readProviderBody, writeToolCall } from "./gateway-provider-fixture.test-support.js";
import {
  createSubagentModelConfig,
  findSubagentRecords,
} from "./server.subagent-stop-settlement.product.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

const opsPrompt = "Keep the operations turn active while research finishes.";
const parentPrompt = "Spawn the research child now.";
const childTask = "Return the isolated research result.";
const childResult = "RESEARCH_CHILD_RESULT_7d61b2";

type ChildSpawnReceipt = { childSessionKey: string; runId: string };

async function startModelServer() {
  const opsStarted = createDeferred();
  const releaseOps = createDeferred();
  const childStarted = createDeferred();
  const releaseChild = createDeferred();
  const childAccepted = createDeferred<ChildSpawnReceipt>();
  const requests: string[] = [];
  let opsRequests = 0;
  const reply = (response: ServerResponse, text: string, id: string) =>
    writeOpenAiResponsesText(response, { text, messageId: id, responseId: `${id}_response` });
  async function handleRequest(request: IncomingMessage, response: ServerResponse) {
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
      const childReceipt = findSubagentRecords(
        JSON.parse(body) as unknown,
        (record) => typeof record.childSessionKey === "string" && typeof record.runId === "string",
      )[0];
      if (
        typeof childReceipt?.childSessionKey === "string" &&
        typeof childReceipt.runId === "string"
      ) {
        childAccepted.resolve({
          childSessionKey: childReceipt.childSessionKey,
          runId: childReceipt.runId,
        });
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
  const server = await startOpenAiResponsesModelServer({
    modelId: "announce-owner",
    bindError: "Expected announce owner model server address",
    onRequest: async (request, response) => {
      try {
        await handleRequest(request, response);
      } catch (error) {
        response.destroy(error instanceof Error ? error : undefined);
      }
    },
  });
  return {
    url: `${server.baseUrl}/v1`,
    opsStarted: opsStarted.promise,
    releaseOps: () => releaseOps.resolve(),
    childStarted: childStarted.promise,
    releaseChild: () => releaseChild.resolve(),
    childAccepted: childAccepted.promise,
    requests,
    close: server.close,
  };
}

function buildConfig(workspace: string, modelUrl: string): OpenClawConfig {
  const config = createSubagentModelConfig(workspace, {
    baseUrl: modelUrl,
    modelId: "announce-owner",
    name: "Announce owner",
    runtime: true,
  });
  return {
    ...config,
    agents: {
      ...config.agents,
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
