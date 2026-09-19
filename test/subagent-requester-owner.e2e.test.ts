import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "../packages/gateway-protocol/src/schema/logs-chat.js";
import type {
  TasksGetResult,
  TasksListResult,
} from "../packages/gateway-protocol/src/schema/tasks.js";
import { writeSubagentSessionEntry } from "../src/agents/subagents/registry/subagent-registry.persistence.test-support.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "../src/agents/subagents/registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../src/agents/subagents/registry/subagent-registry.types.js";
import { getSessionKysely } from "../src/config/sessions/session-accessor.sqlite-scope.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { executeSqliteQuerySync } from "../src/infra/kysely-sync.js";
import { extractFirstTextBlock } from "../src/shared/chat-message-content.js";
import { withOpenClawAgentDatabaseReadOnly } from "../src/state/openclaw-agent-db-readonly.js";
import { closeOpenClawStateDatabaseForTest } from "../src/state/openclaw-state-db.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "./helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";
import { createDeferred, withTestTimeout } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

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
  completionResponseCount: () => number;
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
    "answers status through WebSocket while parent and child provider requests are held",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const parentGate = createDeferred();
      const childGate = createDeferred();
      const modelServer = await startProofModelServer({
        yieldAfterSpawn: parentGate.promise,
        childReply: childGate.promise,
      });
      modelServers.push(modelServer);
      const instance = await createOpenClawTestInstance({
        name: "requester-owner-busy-status",
        config: createTestConfig(modelServer.url),
        env: { OPENCLAW_SKIP_PROVIDERS: undefined, OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
      });
      instances.push(instance);
      instance.state.applyEnv();
      await instance.startGateway();
      const sessionKey = `agent:${REQUESTER_AGENT_ID}:${REQUESTER_KEY}`;
      const statusRunId = "busy-parent-status";
      const statusReply = createDeferred<ChatEvent>();
      const client = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        onEvent: (event) => {
          if (event.event !== "chat") {
            return;
          }
          const chat = event.payload as ChatEvent;
          if (
            chat.runId === statusRunId &&
            (chat.state === "final" || chat.state === "error" || chat.state === "aborted")
          ) {
            statusReply.resolve(chat);
          }
        },
      });
      let parent: Promise<unknown> | undefined;
      let parentSettled = false;
      try {
        parent = client.request(
          "agent",
          {
            sessionKey: REQUESTER_KEY,
            agentId: REQUESTER_AGENT_ID,
            idempotencyKey: "busy-status-parent-turn",
            message: PARENT_PROMPT,
            deliver: false,
          },
          { expectFinal: true },
        );
        void parent.then(
          () => {
            parentSettled = true;
          },
          () => {
            parentSettled = true;
          },
        );
        await vi.waitFor(
          () => {
            expect(modelServer.requestCount(), instance.logs()).toBe(3);
            expect(
              modelServer
                .bodies()
                .filter(
                  (body) => body.includes(PARENT_PROMPT) && body.includes("function_call_output"),
                ),
            ).toHaveLength(1);
            expect(
              modelServer
                .bodies()
                .filter(
                  (body) => body.includes(CHILD_TASK) && !body.includes("function_call_output"),
                ),
            ).toHaveLength(1);
          },
          { interval: 50, timeout: 60_000 },
        );
        const runs = [...loadSubagentRegistryFromSqlite().values()];
        expect(runs, instance.logs()).toHaveLength(1);
        const run = runs[0]!;
        expect(run).toMatchObject({
          requesterAgentId: REQUESTER_AGENT_ID,
          requesterSessionKey: sessionKey,
          requesterTurnRunId: "busy-status-parent-turn",
          completionTarget: "parent",
        });
        expect(run.childSessionKey).toMatch(/^agent:beta:subagent:/);
        const listed = await client.request<TasksListResult>("tasks.list", {
          sessionKey,
          agentId: REQUESTER_AGENT_ID,
        });
        const children = listed.tasks.filter((task) => task.runtime === "subagent");
        expect(children).toHaveLength(1);
        const child = children[0]!;
        expect(child).toMatchObject({
          runId: run.taskRunId ?? run.runId,
          childSessionKey: run.childSessionKey,
          agentId: REQUESTER_AGENT_ID,
          sessionKey,
          status: "running",
          deliveryStatus: "pending",
          execution: { state: "running" },
        });
        // A held HTTP response is not a tool call or an explicit execution wait.
        expect(child.execution?.currentTool).toBeUndefined();
        expect(child.execution?.wait).toBeUndefined();
        const detail = await client.request<TasksGetResult>("tasks.get", { taskId: child.id });
        expect(detail.task).toMatchObject({
          id: child.id,
          runId: child.runId,
          sessionKey,
          childSessionKey: run.childSessionKey,
          prompt: CHILD_TASK,
          status: "running",
          execution: { state: "running" },
          deliveryStatus: "pending",
        });
        expect(detail.task.execution?.currentTool).toBeUndefined();
        expect(detail.task.execution?.wait).toBeUndefined();
        expect(
          await client.request<TasksListResult>("tasks.list", {
            sessionKey: `agent:${OTHER_AGENT_ID}:${REQUESTER_KEY}`,
            agentId: OTHER_AGENT_ID,
          }),
        ).toEqual({ tasks: [] });

        const requestsBeforeStatus = modelServer.requestCount();
        expect(
          await client.request("chat.send", {
            sessionKey,
            agentId: REQUESTER_AGENT_ID,
            message: "/status",
            idempotencyKey: statusRunId,
          }),
        ).toMatchObject({ runId: statusRunId });
        const reply = await withTestTimeout(
          statusReply.promise,
          30_000,
          "status did not finish while the parent provider was held",
        );
        expect(reply, instance.logs()).toMatchObject({
          state: "final",
          runId: statusRunId,
          sessionKey,
        });
        const statusText = "message" in reply ? extractFirstTextBlock(reply.message) : undefined;
        const childLine = statusText
          ?.split("\n")
          .find((line) => line.includes("requester-owner-child"));
        expect(childLine).toMatch(/\brunning\b/);
        expect(childLine).not.toMatch(/\b(waiting|approval|unknown|unavailable)\b/i);
        expect(statusText).not.toContain(CHILD_MARKER);
        expect(parentSettled).toBe(false);
        expect(modelServer.requestCount()).toBe(requestsBeforeStatus);

        childGate.resolve();
        await vi.waitFor(
          () => {
            expect(loadSubagentRegistryFromSqlite().get(run.runId), instance.logs()).toMatchObject({
              execution: { status: "terminal", outcome: { status: "ok" } },
              completion: { resultText: CHILD_MARKER },
              delivery: { status: "pending" },
            });
          },
          { interval: 50, timeout: 30_000 },
        );
        const finished = await client.request<TasksGetResult>("tasks.get", { taskId: child.id });
        expect(finished.task).toMatchObject({
          id: child.id,
          runId: child.runId,
          agentId: REQUESTER_AGENT_ID,
          sessionKey,
          childSessionKey: run.childSessionKey,
          status: "completed",
          execution: { state: "finished" },
          deliveryStatus: "pending",
        });
        expect(finished.task.execution?.currentTool).toBeUndefined();
        expect(finished.task.execution?.wait).toBeUndefined();
        expect(parentSettled).toBe(false);
        expect(modelServer.requestCount()).toBe(requestsBeforeStatus);
        expect(modelServer.countRequestsContaining(CHILD_MARKER)).toBe(0);

        parentGate.resolve();
        expect(await parent, instance.logs()).toMatchObject({ status: "ok" });
        await vi.waitFor(
          async () => {
            const delivered = await client.request<TasksGetResult>("tasks.get", {
              taskId: child.id,
            });
            expect(delivered.task, instance.logs()).toMatchObject({
              status: "completed",
              execution: { state: "finished" },
              deliveryStatus: "delivered",
            });
          },
          { interval: 50, timeout: 30_000 },
        );
        const history = await client.request<{
          messages: Array<{ role?: string; content?: unknown }>;
        }>("chat.history", { sessionKey, agentId: REQUESTER_AGENT_ID, limit: 30 });
        const visible = history.messages.map((message) => ({
          role: message.role,
          text: extractFirstTextBlock(message),
        }));
        expect(
          visible.filter(({ role, text }) => role === "user" && text === "/status"),
        ).toHaveLength(1);
        expect(
          visible.filter(({ role, text }) => role === "assistant" && text === statusText),
        ).toHaveLength(1);
        const statusIndex = visible.findIndex(
          ({ role, text }) => role === "user" && text === "/status",
        );
        expect(visible[statusIndex + 1]).toEqual({ role: "assistant", text: statusText });
        expect(
          visible.filter(({ role, text }) => role === "assistant" && text === CHILD_MARKER),
        ).toHaveLength(1);
        expect(JSON.stringify(history.messages)).not.toContain("This turn ended before a reply");
        const laterModelText = modelServer
          .bodies()
          .slice(requestsBeforeStatus)
          .flatMap((body) => {
            const request = JSON.parse(body) as {
              input: Array<{ role?: string; content?: unknown }>;
            };
            return request.input
              .filter(({ role }) => role === "user" || role === "assistant")
              .map(extractFirstTextBlock);
          });
        expect(laterModelText.some((text) => text?.includes(PARENT_PROMPT))).toBe(true);
        expect(laterModelText).not.toContain("/status");
        expect(laterModelText).not.toContain(statusText);
      } finally {
        childGate.resolve();
        parentGate.resolve();
        await runQaGatewayFixture(
          async () => {
            await withTestTimeout(
              Promise.allSettled(parent ? [parent] : []),
              30_000,
              "parent request did not settle after releasing provider gates",
            );
          },
          () => disconnectGatewayClient(client),
          () => instance.stopGateway(),
          () => closeOpenClawStateDatabaseForTest(),
        );
      }
    },
  );

  it(
    "delivers a private result once when the child finishes before the parent yields",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const yieldGate = createDeferred();
      const modelServer = await startProofModelServer({ yieldAfterSpawn: yieldGate.promise });
      modelServers.push(modelServer);
      const instance = await createOpenClawTestInstance({
        name: "private-completion-before-yield",
        config: createTestConfig(modelServer.url),
        env: { OPENCLAW_SKIP_PROVIDERS: undefined, OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
      });
      instances.push(instance);
      instance.state.applyEnv();
      const sessionId = "private-yield-requester-session";
      const sessionKey = `agent:${REQUESTER_AGENT_ID}:${REQUESTER_KEY}`;
      await writeSubagentSessionEntry({
        stateDir: instance.stateDir,
        agentId: REQUESTER_AGENT_ID,
        sessionKey,
        sessionId,
        defaultSessionId: sessionId,
      });
      closeOpenClawStateDatabaseForTest();
      await instance.startGateway();
      const chatErrors: unknown[] = [];
      const client = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        onEvent: (event) => {
          if (event.event === "chat" && (event.payload as { state?: string })?.state === "error") {
            chatErrors.push(event.payload);
          }
        },
      });
      const readInputs = () =>
        withOpenClawAgentDatabaseReadOnly(
          ({ db }) =>
            executeSqliteQuerySync(
              db,
              getSessionKysely(db)
                .selectFrom("session_pending_inputs")
                .selectAll()
                .where("session_id", "=", sessionId),
            ).rows,
          { agentId: REQUESTER_AGENT_ID },
        );
      try {
        const parent = client.request(
          "agent",
          {
            sessionKey,
            agentId: REQUESTER_AGENT_ID,
            idempotencyKey: "private-yield-parent-turn",
            message: PARENT_PROMPT,
            deliver: false,
          },
          { expectFinal: true },
        );
        void parent.catch(() => {});
        instance.state.applyEnv();
        await vi.waitFor(
          () => {
            const runs = [...loadSubagentRegistryFromSqlite().values()];
            expect(runs, instance.logs()).toHaveLength(1);
            expect(runs[0]).toMatchObject({
              completionTarget: "parent",
              requesterTurnRunId: "private-yield-parent-turn",
              execution: { status: "terminal", outcome: { status: "ok" } },
              completion: { resultText: CHILD_MARKER },
            });
            expect(modelServer.countRequestsContaining(CHILD_MARKER)).toBe(0);
          },
          { interval: 50, timeout: 60_000 },
        );
        // The parent checks the finished child through its real tool before yielding.
        yieldGate.resolve();
        expect(await parent, instance.logs()).toMatchObject({ status: "ok" });
        await vi.waitFor(
          () => {
            const runs = [...loadSubagentRegistryFromSqlite().values()];
            expect(runs, instance.logs()).toHaveLength(1);
            expect(runs[0]?.delivery?.status, instance.logs()).toBe("delivered");
            expect(runs[0]?.requesterSettleWake).toBeUndefined();
          },
          { interval: 50, timeout: 30_000 },
        );
        const receipts = withOpenClawAgentDatabaseReadOnly(
          ({ db }) =>
            executeSqliteQuerySync(
              db,
              getSessionKysely(db)
                .selectFrom("session_input_completions")
                .selectAll()
                .where("session_id", "=", sessionId),
            ).rows,
          { agentId: REQUESTER_AGENT_ID },
        );
        expect(receipts.found).toBe(true);
        if (!receipts.found) {
          throw new Error("Expected durable private completion receipts");
        }
        expect(receipts.value.filter((receipt) => receipt.succeeded === 1)).toHaveLength(1);
        expect(modelServer.completionResponseCount()).toBe(1);
        expect(chatErrors).toEqual([]);
        const history = await client.request<{ messages: unknown[] }>("chat.history", {
          sessionKey,
          agentId: REQUESTER_AGENT_ID,
          limit: 30,
        });
        expect(JSON.stringify(history.messages)).not.toContain("This turn ended before a reply");
        const inputs = readInputs();
        expect(inputs.found && inputs.value.filter((input) => input.state !== "cancelled")).toEqual(
          [],
        );
      } finally {
        yieldGate.resolve();
        await disconnectGatewayClient(client);
        await instance.stopGateway();
      }
      expect(instance.logs()).not.toContain(
        "subagent source lifecycle changed before completion delivery",
      );
    },
  );

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
    logging: { file: "${OPENCLAW_STATE_DIR}/logs/requester-owner-e2e.log" },
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

async function startProofModelServer(options?: {
  yieldAfterSpawn: Promise<void>;
  childReply?: Promise<void>;
}): Promise<ProofModelServer> {
  const requestBodies: string[] = [];
  let parentCheckedChildren = false;
  let parentYielded = false;
  let completionResponses = 0;
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
    if (options?.yieldAfterSpawn && parentCheckedChildren && !parentYielded) {
      parentYielded = true;
      writeOpenAiResponsesSse(response, buildToolCallEvents("sessions_yield", {}));
      return;
    }
    const completion = [RESTORED_CHILD_RESULT, CHILD_MARKER].find((marker) =>
      body.includes(marker),
    );
    if (completion) {
      completionResponses += 1;
      writeOpenAiResponsesText(response, {
        text: completion,
        responseId: `response-${++responseSequence}`,
        messageId: `message-${responseSequence}`,
      });
      return;
    }

    if (body.includes(CHILD_TASK) && !body.includes("function_call_output")) {
      if (options?.childReply) {
        await options.childReply;
      }
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
          ...(options?.yieldAfterSpawn ? { completionTarget: "parent" } : {}),
        }),
      );
      return;
    }
    if (options?.yieldAfterSpawn) {
      await options.yieldAfterSpawn;
      parentCheckedChildren = true;
      writeOpenAiResponsesSse(response, buildToolCallEvents("subagents", { action: "list" }));
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
    completionResponseCount: () => completionResponses,
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
