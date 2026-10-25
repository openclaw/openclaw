import { expectDefined } from "@openclaw/normalization-core";
import type { Compilable, Expression } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { createDeferred } from "./helpers/promise.js";
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
const RESTORED_RUN_ID = "run-requester-owner-legacy";
const RESTORED_REQUESTER_KEY = "requester-owner-legacy-requester";
const RESTORED_CHILD_RESULT = "REQUESTER-OWNER-LEGACY-CHILD-RESULT";

const instances: OpenClawTestInstance[] = [];
const modelServers: Awaited<ReturnType<typeof startProofModelServer>>[] = [];

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

      const expectDelivered = (afterBoot = false) => {
        const run = expectRun(
          instance,
          {
            delivery: { status: "delivered" },
            ...(afterBoot
              ? {
                  requesterAgentId: REQUESTER_AGENT_ID,
                  requesterSessionKey: restored
                    ? sessionKey
                    : `agent:${REQUESTER_AGENT_ID}:${sessionKey}`,
                }
              : {}),
          },
          restored ? RESTORED_RUN_ID : undefined,
        );
        if (restored || afterBoot) {
          expect(run.execution).toMatchObject(
            restored ? { outcome: { status: "ok" } } : successfulExecution,
          );
          expect(run.requesterSettleWake, instance.logs()).toBeUndefined();
        }
      };
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
          await poll(expectDelivered, 25_000);
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

      instance.state.applyEnv();
      try {
        expectDelivered(true);
      } finally {
        closeOpenClawStateDatabaseForTest();
      }
      expect(instance.logs()).not.toContain("Subagent announce failed");
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
      const session = (sessionKey: string) =>
        loadSessionEntry({ agentId: REQUESTER_AGENT_ID, sessionKey });
      const requester = expectDefined(
        session(RESTORED_REQUESTER_KEY),
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
            sessionEntry: session(childSessionKey),
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
        return respondWithTool("sessions_yield", {});
      }
      const completion = [RESTORED_CHILD_RESULT, CHILD_MARKER].find((marker) =>
        body.includes(marker),
      );
      if (completion) {
        completionResponses += 1;
        return respondWithText(completion);
      }

      if (body.includes(CHILD_TASK) && !body.includes("function_call_output")) {
        return respondWithText(CHILD_MARKER);
      }
      if (body.includes(PARENT_PROMPT) && !body.includes("function_call_output")) {
        return respondWithTool("sessions_spawn", {
          task: CHILD_TASK,
          label: "requester-owner-child",
          ...(options?.placement ? { placement: options.placement } : {}),
          thread: false,
          mode: "run",
          ...(options?.yieldAfterSpawn ? { completionTarget: "parent" } : {}),
        });
      }
      if (options?.yieldAfterSpawn) {
        await options.yieldAfterSpawn;
        parentCheckedChildren = true;
        return respondWithTool("subagents", { action: "list" });
      }
      respondWithText("REQUESTER-OWNER-PARENT-OK");
    },
  });
  return {
    countRequestsContaining: (marker: string) =>
      requestBodies.filter((entry) => entry.includes(marker)).length,
    completionResponseCount: () => completionResponses,
    requestCount: () => requestBodies.length,
    url: server.baseUrl,
    close: server.close,
  };
}
