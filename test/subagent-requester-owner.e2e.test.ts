import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeSubagentSessionEntry } from "../src/agents/subagents/registry/subagent-registry.persistence.test-support.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "../src/agents/subagents/registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../src/agents/subagents/registry/subagent-registry.types.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { closeOpenClawStateDatabaseForTest } from "../src/state/openclaw-state-db.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "./helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const TEST_TIMEOUT_MS = 180_000;
const MODEL_REF = "requester-owner/synthetic";
const REQUESTER_KEY = "requester-owner-requester";
const REQUESTER_AGENT_ID = "beta";
const OTHER_AGENT_ID = "alpha";
const PARENT_PROMPT = "REQUESTER-OWNER parent: spawn one worker and finish without waiting.";
const CHILD_TASK = "REQUESTER-OWNER child task: reply with the agreed child token.";
const CHILD_MARKER = "REQUESTER-OWNER-CHILD-OK";
const ANNOUNCE_FAILURE_MARKER = "Subagent announce failed";
const RESTORED_RUN_ID = "run-requester-owner-legacy";
const RESTORED_REQUESTER_KEY = "requester-owner-legacy-requester";
const RESTORED_CHILD_RESULT = "REQUESTER-OWNER-LEGACY-CHILD-RESULT";

type SseEvent = Record<string, unknown>;

type ProofModelServer = {
  bodies: () => readonly string[];
  close: () => Promise<void>;
  countRequestsContaining: (marker: string) => number;
  requestCount: () => number;
  url: string;
};

const instances: OpenClawTestInstance[] = [];
const modelServers: ProofModelServer[] = [];

afterEach(async () => {
  const results = await Promise.allSettled([
    ...instances.splice(0).map((instance) => instance.cleanup()),
    ...modelServers.splice(0).map((server) => server.close()),
  ]);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length > 0) {
    throw new AggregateError(errors, "Requester fixture cleanup failed");
  }
});

describe("REQUESTER-OWNER requester agent id survives completion dispatch", () => {
  it(
    "preserves the requester owner through a fresh normalized spawn",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const modelServer = await startProofModelServer();
      modelServers.push(modelServer);
      const instance = await createOpenClawTestInstance({
        name: "requester-owner-requester-agent-id",
        config: createTestConfig(modelServer.url),
        env: { OPENCLAW_SKIP_PROVIDERS: undefined, OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
      });
      instances.push(instance);

      instance.state.applyEnv();
      try {
        await writeSubagentSessionEntry({
          stateDir: instance.stateDir,
          agentId: REQUESTER_AGENT_ID,
          sessionKey: REQUESTER_KEY,
          sessionId: "requester-owner-requester-session",
          defaultSessionId: "requester-owner-requester-session",
        });
      } finally {
        closeOpenClawStateDatabaseForTest();
      }

      await instance.startGateway();
      const client = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
      });
      try {
        const parent = client.request(
          "agent",
          {
            sessionKey: REQUESTER_KEY,
            agentId: REQUESTER_AGENT_ID,
            idempotencyKey: "requester-owner-parent-turn",
            message: PARENT_PROMPT,
            deliver: false,
          },
          { expectFinal: true },
        );
        void parent.catch(() => {});
        await vi.waitFor(
          () => expect(modelServer.countRequestsContaining(CHILD_MARKER)).toBeGreaterThan(0),
          { interval: 50, timeout: 90_000 },
        );
        expect(await parent).toMatchObject({ status: "ok" });
        instance.state.applyEnv();
        await vi.waitFor(
          () => {
            const runs = [...loadSubagentRegistryFromSqlite().values()];
            expect(runs).toHaveLength(1);
            expect(runs[0]?.delivery?.status).toBe("delivered");
          },
          { interval: 50, timeout: 25_000 },
        );
        const requester = await client.request<{ messages: unknown[] }>("chat.history", {
          sessionKey: REQUESTER_KEY,
          agentId: REQUESTER_AGENT_ID,
          limit: 30,
        });
        const other = await client.request<{ messages: unknown[] }>("chat.history", {
          sessionKey: REQUESTER_KEY,
          agentId: OTHER_AGENT_ID,
          limit: 30,
        });
        expect(
          requester.messages.filter((message) => JSON.stringify(message).includes(CHILD_MARKER)),
        ).toHaveLength(1);
        expect(other.messages).toEqual([]);
      } finally {
        await disconnectGatewayClient(client);
        await instance.stopGateway();
      }

      const logs = instance.logs();
      instance.state.applyEnv();
      try {
        const runs = [...loadSubagentRegistryFromSqlite().values()];
        expect(runs, logs).toHaveLength(1);
        const run = runs[0]!;
        expect(run.requesterAgentId, logs).toBe(REQUESTER_AGENT_ID);
        expect(run.requesterSessionKey, logs).toBe(`agent:${REQUESTER_AGENT_ID}:${REQUESTER_KEY}`);
        expect(run.execution.status, logs).toBe("terminal");
        expect(run.execution.outcome, logs).toMatchObject({ status: "ok" });
        expect(run.delivery?.status, logs).toBe("delivered");
        expect(run.requesterSettleWake, logs).toBeUndefined();
      } finally {
        closeOpenClawStateDatabaseForTest();
      }
      expect(logs).not.toContain(ANNOUNCE_FAILURE_MARKER);
    },
  );

  it(
    "delivers a restored unscoped completion once across Gateway restarts",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const modelServer = await startProofModelServer();
      modelServers.push(modelServer);
      const instance = await createOpenClawTestInstance({
        name: "requester-owner-legacy-unscoped-requester",
        config: createTestConfig(modelServer.url),
        env: { OPENCLAW_SKIP_PROVIDERS: undefined, OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
      });
      instances.push(instance);

      instance.state.applyEnv();
      try {
        const endedAt = Date.now();
        const restored: SubagentRunRecord = {
          runId: RESTORED_RUN_ID,
          childSessionKey: `agent:${REQUESTER_AGENT_ID}:subagent:requester-owner-legacy`,
          requesterSessionKey: RESTORED_REQUESTER_KEY,
          requesterDisplayKey: RESTORED_REQUESTER_KEY,
          requesterAgentId: REQUESTER_AGENT_ID,
          task: "REQUESTER-OWNER legacy restored completion",
          cleanup: "keep",
          createdAt: endedAt - 2_000,
          endedReason: "subagent-complete",
          execution: {
            status: "terminal",
            startedAt: endedAt - 1_000,
            endedAt,
            outcome: { status: "ok" },
          },
          expectsCompletionMessage: true,
          completion: { required: true, resultText: RESTORED_CHILD_RESULT, capturedAt: endedAt },
          delivery: { status: "pending" },
        };
        saveSubagentRegistryToSqlite(new Map([[restored.runId, restored]]));
        await writeSubagentSessionEntry({
          stateDir: instance.stateDir,
          agentId: REQUESTER_AGENT_ID,
          sessionKey: RESTORED_REQUESTER_KEY,
          sessionId: "requester-owner-legacy-session",
          defaultSessionId: "requester-owner-legacy-session",
        });
        await writeSubagentSessionEntry({
          stateDir: instance.stateDir,
          agentId: REQUESTER_AGENT_ID,
          sessionKey: restored.childSessionKey,
          sessionId: "requester-owner-legacy-child-session",
          defaultSessionId: "requester-owner-legacy-child-session",
        });
        const seeded = loadSubagentRegistryFromSqlite().get(RESTORED_RUN_ID);
        expect(seeded?.requesterAgentId).toBe(REQUESTER_AGENT_ID);
        expect(seeded?.requesterSessionKey).toBe(RESTORED_REQUESTER_KEY);
        expect(seeded?.delivery?.status).toBe("pending");
      } finally {
        closeOpenClawStateDatabaseForTest();
      }

      let settledRequests: number | undefined;
      for (let boot = 0; boot < 2; boot += 1) {
        await instance.startGateway();
        const client = await connectGatewayClient({
          url: instance.url,
          token: instance.gatewayToken,
        });
        try {
          instance.state.applyEnv();
          await vi.waitFor(
            () => {
              const run = loadSubagentRegistryFromSqlite().get(RESTORED_RUN_ID);
              expect(run?.delivery?.status, instance.logs()).toBe("delivered");
              expect(run?.execution.outcome).toMatchObject({ status: "ok" });
              expect(run?.requesterSettleWake).toBeUndefined();
            },
            { interval: 50, timeout: 25_000 },
          );
          const requester = await client.request<{ messages: unknown[] }>("chat.history", {
            sessionKey: RESTORED_REQUESTER_KEY,
            agentId: REQUESTER_AGENT_ID,
            limit: 30,
          });
          const other = await client.request<{ messages: unknown[] }>("chat.history", {
            sessionKey: RESTORED_REQUESTER_KEY,
            agentId: OTHER_AGENT_ID,
            limit: 30,
          });
          expect(
            requester.messages.filter((message) =>
              JSON.stringify(message).includes(RESTORED_CHILD_RESULT),
            ),
          ).toHaveLength(1);
          expect(other.messages).toEqual([]);
          expect(modelServer.countRequestsContaining(RESTORED_CHILD_RESULT)).toBe(1);
          if (settledRequests !== undefined) {
            expect(modelServer.requestCount()).toBe(settledRequests);
          }
          settledRequests = modelServer.requestCount();
        } finally {
          await disconnectGatewayClient(client);
          await instance.stopGateway();
        }
      }

      const logs = instance.logs();
      expect(logs).not.toContain(ANNOUNCE_FAILURE_MARKER);
      instance.state.applyEnv();
      try {
        const run = loadSubagentRegistryFromSqlite().get(RESTORED_RUN_ID);
        expect(run?.requesterAgentId, logs).toBe(REQUESTER_AGENT_ID);
        expect(run?.requesterSessionKey, logs).toBe(RESTORED_REQUESTER_KEY);
        expect(run?.delivery?.status, logs).toBe("delivered");
      } finally {
        closeOpenClawStateDatabaseForTest();
      }
    },
  );
});

function createTestConfig(baseUrl: string): OpenClawConfig {
  return {
    plugins: { enabled: false },
    agents: {
      ownership: "explicit",
      entries: { [OTHER_AGENT_ID]: {}, [REQUESTER_AGENT_ID]: {} },
      defaults: {
        heartbeat: { every: "0m" },
        maxConcurrent: 8,
        model: { primary: MODEL_REF },
        models: { [MODEL_REF]: { agentRuntime: { id: "openclaw" } } },
        skipBootstrap: true,
        skills: [],
      },
    },
    tools: { profile: "coding" },
    models: {
      mode: "replace",
      providers: {
        "requester-owner": {
          baseUrl: `${baseUrl}/v1`,
          apiKey: "test-token-placeholder",
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "synthetic",
              name: "requester-owner",
              api: "openai-responses",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 4_096,
            },
          ],
        },
      },
    },
  };
}

let responseSequence = 0;

function buildToolCallEvents(name: string, args: Record<string, unknown>): SseEvent[] {
  const sequence = ++responseSequence;
  const responseId = `resp_requester-owner_tool_${sequence}`;
  const itemId = `fc_requester-owner_${sequence}`;
  const callId = `call_requester-owner_${sequence}`;
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

async function startProofModelServer(): Promise<ProofModelServer> {
  const requestBodies: string[] = [];
  const server = createServer((request, response) => {
    void handleModelRequest(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
      }
      response.end(JSON.stringify({ error: { message: String(error) } }));
    });
  });

  async function handleModelRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "requester-owner", object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of request) {
      body += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    }
    requestBodies.push(body);
    const completion = [RESTORED_CHILD_RESULT, CHILD_MARKER].find((marker) =>
      body.includes(marker),
    );
    if (completion) {
      writeOpenAiResponsesText(response, {
        text: completion,
        responseId: `response-${++responseSequence}`,
        messageId: `message-${responseSequence}`,
      });
      return;
    }

    if (body.includes(CHILD_TASK) && !body.includes("function_call_output")) {
      writeOpenAiResponsesText(response, {
        text: CHILD_MARKER,
        responseId: `response-${++responseSequence}`,
        messageId: `message-${responseSequence}`,
      });
      return;
    }
    if (body.includes(PARENT_PROMPT) && !body.includes("function_call_output")) {
      writeOpenAiResponsesSse(
        response,
        buildToolCallEvents("sessions_spawn", {
          task: CHILD_TASK,
          label: "requester-owner-child",
          thread: false,
          mode: "run",
        }),
      );
      return;
    }
    writeOpenAiResponsesText(response, {
      text: "REQUESTER-OWNER-PARENT-OK",
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
    bodies: () => requestBodies,
    countRequestsContaining: (marker) =>
      requestBodies.filter((entry) => entry.includes(marker)).length,
    requestCount: () => requestBodies.length,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
