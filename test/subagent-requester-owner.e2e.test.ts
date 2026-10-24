import { expectDefined } from "@openclaw/normalization-core";
import type { Compilable, Expression } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "../packages/gateway-protocol/src/schema/logs-chat.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "../src/agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import {
  settleSubagentRegistryPersistenceWork,
  writeSubagentSessionEntry,
} from "../src/agents/subagents/registry/subagent-registry.persistence.test-support.js";
import type { SubagentRunRecord } from "../src/agents/subagents/registry/subagent-registry.types.js";
import { loadConfig } from "../src/config/io.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../src/config/runtime-snapshot.js";
import { loadSessionEntry } from "../src/config/sessions/session-accessor.js";
import { getSessionKysely } from "../src/config/sessions/session-accessor.sqlite-scope.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import {
  readProviderBody,
  writeToolCall,
} from "../src/gateway/gateway-provider-fixture.test-support.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { executeSqliteQuerySync } from "../src/infra/kysely-sync.js";
import { extractFirstTextBlock } from "../src/shared/chat-message-content.js";
import { withOpenClawAgentDatabaseReadOnly } from "../src/state/openclaw-agent-db-readonly.js";
import { closeOpenClawStateDatabaseForTest } from "../src/state/openclaw-state-db.js";
import { startOpenAiResponsesModelServer } from "./helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";
import { createDeferred, withTestTimeout } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";
import { withSubagentRecoveryOperator } from "./helpers/subagent-recovery-operator.js";

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

type ProofModelServer = Awaited<ReturnType<typeof startProofModelServer>>;

const instances: OpenClawTestInstance[] = [];
const modelServers: ProofModelServer[] = [];

async function createFixture(name: string, options?: Parameters<typeof startProofModelServer>[0]) {
  const modelServer = await startProofModelServer(options);
  modelServers.push(modelServer);
  const instance = await createOpenClawTestInstance({
    name,
    config: createTestConfig(modelServer.url),
    env: { OPENCLAW_SKIP_PROVIDERS: undefined, OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
  });
  instances.push(instance);
  instance.state.applyEnv();
  return { instance, modelServer };
}

function writeSession(instance: OpenClawTestInstance, sessionKey: string, sessionId: string) {
  return writeSubagentSessionEntry({
    stateDir: instance.stateDir,
    agentId: REQUESTER_AGENT_ID,
    sessionKey,
    defaultSessionId: sessionId,
  });
}

type Client = Awaited<ReturnType<typeof connectGatewayClient>>;
async function startClient(
  instance: OpenClawTestInstance,
  onEvent?: Parameters<typeof connectGatewayClient>[0]["onEvent"],
) {
  await instance.startGateway();
  return connectGatewayClient({ url: instance.url, token: instance.gatewayToken, onEvent });
}

function readSessionRows<Row>(
  query: (db: ReturnType<typeof getSessionKysely>) => Compilable<Row> & Expression<Row>,
) {
  return withOpenClawAgentDatabaseReadOnly(
    ({ db }) => executeSqliteQuerySync<Row>(db, query(getSessionKysely(db))).rows,
    { agentId: REQUESTER_AGENT_ID },
  );
}

function startParent(client: Client, sessionKey: string, idempotencyKey: string) {
  return client.request(
    "agent",
    {
      sessionKey,
      agentId: REQUESTER_AGENT_ID,
      idempotencyKey,
      message: PARENT_PROMPT,
      deliver: false,
    },
    { expectFinal: true },
  );
}

function readHistory(client: Client, sessionKey: string, agentId = REQUESTER_AGENT_ID) {
  return client.request<{ messages: Array<{ role?: string; content?: unknown }> }>("chat.history", {
    sessionKey,
    agentId,
    limit: 30,
  });
}

const poll = <T>(callback: () => T, timeout: number) =>
  vi.waitFor(callback, { interval: 50, timeout });
const successfulExecution = { status: "terminal", outcome: { status: "ok" } };

function expectRun(instance: OpenClawTestInstance, expected: object, runId?: string) {
  const runs = loadSubagentRegistryFromSqlite();
  if (!runId) {
    expect(runs.size, instance.logs()).toBe(1);
  }
  const run = expectDefined(runId ? runs.get(runId) : runs.values().next().value, "child run");
  expect(run, instance.logs()).toMatchObject(expected);
  return run;
}

function waitForRun(
  instance: OpenClawTestInstance,
  expected: object,
  timeout: number,
  runId?: string,
) {
  return poll(() => expectRun(instance, expected, runId), timeout);
}

afterEach(async () => {
  const results = await Promise.allSettled([
    ...instances.splice(0).map((instance) => instance.cleanup()),
    ...modelServers.splice(0).map((server) => server.close()),
  ]);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  clearRuntimeConfigSnapshot();
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
      const { instance, modelServer } = await createFixture("requester-owner-busy-status", {
        yieldAfterSpawn: parentGate.promise,
        childReply: childGate.promise,
      });
      const sessionKey = `agent:${REQUESTER_AGENT_ID}:${REQUESTER_KEY}`;
      const statusRunId = "busy-parent-status";
      const statusReply = createDeferred<ChatEvent>();
      const client = await startClient(instance, (event) => {
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
      });
      let parent: Promise<unknown> | undefined;
      let parentSettled = false;
      try {
        parent = startParent(client, REQUESTER_KEY, "busy-status-parent-turn");
        const onSettled = () => {
          parentSettled = true;
        };
        void parent.then(onSettled, onSettled);
        await poll(() => {
          expect(modelServer.requestCount(), instance.logs()).toBe(3);
          const bodies = modelServer.bodies();
          expect(
            bodies.filter(
              (body) => body.includes(PARENT_PROMPT) && body.includes("function_call_output"),
            ),
          ).toHaveLength(1);
          expect(
            bodies.filter(
              (body) => body.includes(CHILD_TASK) && !body.includes("function_call_output"),
            ),
          ).toHaveLength(1);
        }, 60_000);
        const run = expectRun(instance, {
          requesterAgentId: REQUESTER_AGENT_ID,
          requesterSessionKey: sessionKey,
          requesterTurnRunId: "busy-status-parent-turn",
          completionTarget: "parent",
          execution: { status: "running" },
          task: CHILD_TASK,
        });
        expect(run.childSessionKey).toMatch(/^agent:beta:subagent:/);

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
        expect(statusText).toBeTruthy();
        expect(statusText).not.toContain(CHILD_MARKER);
        expect(parentSettled).toBe(false);
        expect(modelServer.requestCount()).toBe(requestsBeforeStatus);

        childGate.resolve();
        await waitForRun(
          instance,
          {
            execution: successfulExecution,
            completion: { resultText: CHILD_MARKER },
            delivery: { status: "pending" },
          },
          30_000,
          run.runId,
        );
        expect(parentSettled).toBe(false);
        expect(modelServer.requestCount()).toBe(requestsBeforeStatus);
        expect(modelServer.countRequestsContaining(CHILD_MARKER)).toBe(0);

        parentGate.resolve();
        expect(await parent, instance.logs()).toMatchObject({ status: "ok" });
        await waitForRun(
          instance,
          {
            execution: successfulExecution,
            delivery: { status: "delivered" },
          },
          30_000,
          run.runId,
        );
        const history = await readHistory(client, sessionKey);
        const visible = history.messages.map((message) => ({
          role: message.role,
          text: extractFirstTextBlock(message),
        }));
        const messages = (role: string, text: string | undefined) =>
          visible.filter((message) => message.role === role && message.text === text);
        expect(messages("user", "/status")).toHaveLength(1);
        expect(messages("assistant", statusText)).toHaveLength(1);
        const statusIndex = visible.findIndex(
          ({ role, text }) => role === "user" && text === "/status",
        );
        expect(visible[statusIndex + 1]).toEqual({ role: "assistant", text: statusText });
        expect(messages("assistant", CHILD_MARKER)).toHaveLength(1);
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

  it.each([undefined, { kind: "local" } as const])(
    "resumes a yielded requester once after its private child finishes (placement: %j)",
    { timeout: TEST_TIMEOUT_MS },
    async (placement) => {
      const yieldGate = createDeferred();
      const { instance, modelServer } = await createFixture("private-completion-before-yield", {
        yieldAfterSpawn: yieldGate.promise,
        placement,
      });
      const sessionId = "private-yield-requester-session";
      const sessionKey = `agent:${REQUESTER_AGENT_ID}:${REQUESTER_KEY}`;
      await writeSession(instance, sessionKey, sessionId);
      closeOpenClawStateDatabaseForTest();
      const chatErrors: unknown[] = [];
      const client = await startClient(instance, (event) => {
        if (event.event === "chat" && (event.payload as { state?: string })?.state === "error") {
          chatErrors.push(event.payload);
        }
      });
      try {
        const parent = startParent(client, sessionKey, "private-yield-parent-turn");
        void parent.catch(() => {});
        instance.state.applyEnv();
        await poll(() => {
          expectRun(instance, {
            completionTarget: "parent",
            requesterTurnRunId: "private-yield-parent-turn",
            execution: successfulExecution,
            completion: { resultText: CHILD_MARKER },
          });
          expect(modelServer.countRequestsContaining(CHILD_MARKER)).toBe(0);
        }, 60_000);
        // The parent checks the finished child through its real tool before yielding.
        yieldGate.resolve();
        expect(await parent, instance.logs()).toMatchObject({ status: "ok" });
        const settledRun = await poll(() => {
          const run = expectRun(instance, { delivery: { status: "delivered" } });
          expect(run.requesterSettleWake).toBeUndefined();
          return run;
        }, 30_000);
        const receipts = readSessionRows((db) =>
          db
            .selectFrom("session_input_completions")
            .selectAll()
            .where("session_id", "=", sessionId),
        );
        expect(receipts.found).toBe(true);
        if (!receipts.found) {
          throw new Error("Expected requester database for completion verification");
        }
        const settleRunId = `announce:requester-settle:${REQUESTER_AGENT_ID}:${sessionKey}:${settledRun.runId}:yield-1`;
        expect(receipts.value).toHaveLength(1);
        const receipt = expectDefined(receipts.value[0], "requester completion receipt");
        expect(receipt).toMatchObject({
          run_id: settleRunId,
          idempotency_key: `${settleRunId}:user`,
          succeeded: 1,
        });
        expect(JSON.parse(receipt.outcome_json)).toMatchObject({
          reason: "completed",
          status: "ok",
        });
        expect(modelServer.completionResponseCount()).toBe(1);
        expect(chatErrors).toEqual([]);
        const history = await readHistory(client, sessionKey);
        expect(
          history.messages.filter(
            (message) =>
              message.role === "assistant" && extractFirstTextBlock(message) === CHILD_MARKER,
          ),
        ).toHaveLength(1);
        expect(JSON.stringify(history.messages)).not.toContain("This turn ended before a reply");
        const inputs = readSessionRows((db) =>
          db.selectFrom("session_pending_inputs").selectAll().where("session_id", "=", sessionId),
        );
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

  it.each(["fresh", "restored"] as const)(
    "preserves requester ownership for a %s completion across Gateway boots",
    { timeout: TEST_TIMEOUT_MS },
    async (kind) => {
      const restored = kind === "restored";
      const sessionKey = restored ? RESTORED_REQUESTER_KEY : REQUESTER_KEY;
      const marker = restored ? RESTORED_CHILD_RESULT : CHILD_MARKER;
      const { instance, modelServer } = await createFixture(
        restored
          ? "requester-owner-legacy-unscoped-requester"
          : "requester-owner-requester-agent-id",
      );
      if (restored) {
        await seedRestoredCompletion(instance);
      } else {
        try {
          await writeSession(instance, sessionKey, "requester-owner-requester-session");
        } finally {
          closeOpenClawStateDatabaseForTest();
        }
      }

      let settledRequests: number | undefined;
      for (let boot = 0; boot < (restored ? 2 : 1); boot += 1) {
        const client = await startClient(instance);
        try {
          if (!restored) {
            const parent = startParent(client, sessionKey, "requester-owner-parent-turn");
            void parent.catch(() => {});
            await poll(
              () => expect(modelServer.countRequestsContaining(marker)).toBeGreaterThan(0),
              90_000,
            );
            expect(await parent).toMatchObject({ status: "ok" });
          }
          instance.state.applyEnv();
          await poll(() => {
            const run = expectRun(
              instance,
              { delivery: { status: "delivered" } },
              restored ? RESTORED_RUN_ID : undefined,
            );
            if (restored) {
              expect(run.execution.outcome).toMatchObject({ status: "ok" });
              expect(run.requesterSettleWake).toBeUndefined();
            }
          }, 25_000);
          const requester = await readHistory(client, sessionKey);
          const other = await readHistory(client, sessionKey, OTHER_AGENT_ID);
          expect(
            requester.messages.filter((message) => JSON.stringify(message).includes(marker)),
          ).toHaveLength(1);
          expect(other.messages).toEqual([]);
          if (restored) {
            expect(modelServer.countRequestsContaining(marker)).toBe(1);
          }
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
      instance.state.applyEnv();
      try {
        const run = expectRun(
          instance,
          {
            requesterAgentId: REQUESTER_AGENT_ID,
            requesterSessionKey: restored
              ? sessionKey
              : `agent:${REQUESTER_AGENT_ID}:${sessionKey}`,
            delivery: { status: "delivered" },
          },
          restored ? RESTORED_RUN_ID : undefined,
        );
        if (!restored) {
          expect(run.execution).toMatchObject(successfulExecution);
          expect(run.requesterSettleWake, logs).toBeUndefined();
        }
      } finally {
        closeOpenClawStateDatabaseForTest();
      }
      expect(logs).not.toContain(ANNOUNCE_FAILURE_MARKER);
    },
  );
});

async function seedRestoredCompletion(instance: OpenClawTestInstance) {
  const gatewayConfig = loadConfig();
  setRuntimeConfigSnapshot(gatewayConfig);
  const registry =
    await import("../src/agents/subagents/registry/subagent-registry.test-helpers.js");
  await runQaGatewayFixture(
    async () => {
      await registry.resetSubagentRegistryForTests({ persist: false });
      const childSessionKey = `agent:${REQUESTER_AGENT_ID}:subagent:requester-owner-legacy`;
      await writeSession(instance, RESTORED_REQUESTER_KEY, "requester-owner-legacy-session");
      await writeSession(instance, childSessionKey, "requester-owner-legacy-child-session");
      const requester = expectDefined(
        loadSessionEntry({
          agentId: REQUESTER_AGENT_ID,
          sessionKey: RESTORED_REQUESTER_KEY,
        }),
        "restored requester session",
      );
      // Registration owns native child execution and physical-store provenance even for a bare key.
      // Queue only while preparing stored completion state; no child RPC is dispatched.
      const profileId = await withSubagentRecoveryOperator(
        gatewayConfig,
        async (admittedProfileId) => {
          await registry.registerSubagentRun({
            runId: RESTORED_RUN_ID,
            childSessionKey,
            requesterSessionKey: RESTORED_REQUESTER_KEY,
            requesterDisplayKey: RESTORED_REQUESTER_KEY,
            requesterAgentId: REQUESTER_AGENT_ID,
            requesterTurnRunId: "requester-owner-restored-parent-turn",
            completionRequesterSessionId: requester.sessionId,
            completionRequesterLifecycleRevision: requester.lifecycleRevision,
            childAgentId: REQUESTER_AGENT_ID,
            sessionEntry: loadSessionEntry({
              agentId: REQUESTER_AGENT_ID,
              sessionKey: childSessionKey,
            }),
            task: "REQUESTER-OWNER legacy restored completion",
            cleanup: "keep",
            expectsCompletionMessage: true,
            queued: true,
          });
          return admittedProfileId;
        },
      );
      const registered = expectDefined(
        loadSubagentRegistryFromSqlite().get(RESTORED_RUN_ID),
        "Restored requester fixture registration was not persisted",
      );
      expect(registered.requesterStorePath).toBeTruthy();
      expect(registered.controllerStorePath).toBe(registered.requesterStorePath);
      expect(registered.operatorRecoverySource).toMatchObject({
        agentId: REQUESTER_AGENT_ID,
        sessionKey: RESTORED_REQUESTER_KEY,
        sessionId: requester.sessionId,
        sourceRunId: "requester-owner-restored-parent-turn",
        snapshot: {
          profileId,
          scopes: ["operator.write"],
          grant: null,
        },
      });
      // Retire setup callbacks, not durable ownership, before freezing the completed fixture.
      await registry.resetSubagentRegistryForTests({ persist: false });
      const endedAt = Date.now();
      const restored: SubagentRunRecord = {
        ...registered,
        // The parent turn has ended; only its admitted child completion remains owed.
        requesterTurnRunId: undefined,
        endedReason: "subagent-complete",
        execution: {
          ...registered.execution,
          status: "terminal",
          startedAt: registered.createdAt,
          endedAt,
          outcome: { status: "ok" },
        },
        completion: {
          required: true,
          terminalReply: { disposition: "visible", text: RESTORED_CHILD_RESULT },
          resultText: RESTORED_CHILD_RESULT,
          capturedAt: endedAt,
        },
      };
      saveSubagentRegistryToSqlite(new Map([[restored.runId, restored]]));
      const seeded = loadSubagentRegistryFromSqlite().get(RESTORED_RUN_ID);
      expect(seeded).toMatchObject({
        requesterAgentId: REQUESTER_AGENT_ID,
        requesterSessionKey: RESTORED_REQUESTER_KEY,
        delivery: { status: "pending" },
      });
    },
    () => settleSubagentRegistryPersistenceWork(),
    () => registry.resetSubagentRegistryForTests({ persist: false }),
    () => closeOpenClawStateDatabaseForTest(),
  );
}

function createTestConfig(baseUrl: string): OpenClawConfig {
  const model = buildMockOpenAiResponsesProvider(`${baseUrl}/v1`, "synthetic").config;
  return {
    logging: { file: "${OPENCLAW_STATE_DIR}/logs/requester-owner-e2e.log" },
    plugins: { enabled: false },
    cron: { enabled: false },
    agents: {
      ownership: "explicit",
      entries: { [OTHER_AGENT_ID]: {}, [REQUESTER_AGENT_ID]: {} },
      defaults: {
        maxConcurrent: 8,
        model: { primary: MODEL_REF },
        models: { [MODEL_REF]: { agentRuntime: { id: "openclaw" } } },
        skipBootstrap: true,
        skills: [],
      },
    },
    tools: { profile: "coding", codeMode: false, toolSearch: false },
    models: {
      mode: "replace",
      providers: {
        "requester-owner": {
          ...model,
          apiKey: "test-token-placeholder",
          request: { allowPrivateNetwork: true },
          models: [{ ...model.models[0], name: "requester-owner" }],
        },
      },
    },
  };
}

let responseSequence = 0;

async function startProofModelServer(options?: {
  yieldAfterSpawn: Promise<void>;
  childReply?: Promise<void>;
  placement?: { kind: "local" };
}) {
  const requestBodies: string[] = [];
  let parentCheckedChildren = false;
  let parentYielded = false;
  let completionResponses = 0;
  const server = await startOpenAiResponsesModelServer({
    modelId: "requester-owner",
    bindError: "Requester model fixture did not bind a loopback port",
    onRequest: async (request, response) => {
      const body = await readProviderBody(request);
      requestBodies.push(body);
      const requestBody = JSON.parse(body) as { tools?: Array<{ type?: string; name?: string }> };
      const respondWithTool = (name: string, args: Record<string, unknown>) => {
        expect(requestBody.tools).toEqual(
          expect.arrayContaining([expect.objectContaining({ type: "function", name })]),
        );
        writeToolCall(response, name, args, 8, 4);
      };
      const respondWithText = (text: string) =>
        writeOpenAiResponsesText(response, {
          text,
          responseId: `response-${++responseSequence}`,
          messageId: `message-${responseSequence}`,
        });
      if (options?.yieldAfterSpawn && parentCheckedChildren && !parentYielded) {
        parentYielded = true;
        respondWithTool("sessions_yield", {});
        return;
      }
      const completion = [RESTORED_CHILD_RESULT, CHILD_MARKER].find((marker) =>
        body.includes(marker),
      );
      if (completion) {
        completionResponses += 1;
        respondWithText(completion);
        return;
      }

      if (body.includes(CHILD_TASK) && !body.includes("function_call_output")) {
        if (options?.childReply) {
          await options.childReply;
        }
        respondWithText(CHILD_MARKER);
        return;
      }
      if (body.includes(PARENT_PROMPT) && !body.includes("function_call_output")) {
        respondWithTool("sessions_spawn", {
          task: CHILD_TASK,
          label: "requester-owner-child",
          ...(options?.placement ? { placement: options.placement } : {}),
          thread: false,
          mode: "run",
          ...(options?.yieldAfterSpawn ? { completionTarget: "parent" } : {}),
        });
        return;
      }
      if (options?.yieldAfterSpawn) {
        await options.yieldAfterSpawn;
        parentCheckedChildren = true;
        respondWithTool("subagents", { action: "list" });
        return;
      }
      respondWithText("REQUESTER-OWNER-PARENT-OK");
    },
  });
  return {
    bodies: () => requestBodies,
    countRequestsContaining: (marker: string) =>
      requestBodies.filter((entry) => entry.includes(marker)).length,
    completionResponseCount: () => completionResponses,
    requestCount: () => requestBodies.length,
    url: server.baseUrl,
    close: server.close,
  };
}
