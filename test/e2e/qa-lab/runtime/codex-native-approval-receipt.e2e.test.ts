// QA Lab proves a Codex-native approval decision through Gateway receipt restart.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditRunInspectResult } from "../../../../packages/gateway-protocol/src/index.js";
import { writePersistedAuthProfileStoreRaw } from "../../../../src/agents/auth-profiles/sqlite.js";
import {
  GatewayClient,
  startGatewayClientWhenEventLoopReady,
} from "../../../../src/plugin-sdk/gateway-runtime.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../../../src/state/openclaw-agent-db.js";
import { loadBundledPluginFacade } from "../../../../src/test-utils/bundled-plugin-public-surface.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";
import { createDeferred, withinTest } from "../../../helpers/promise.js";

const MODEL = "openai/gpt-5.6-luna";
const REQUEST_TIMEOUT_MS = 60_000;
const PRIVATE_COMMAND = "printf PRIVATE_CODEX_NATIVE_APPROVAL_COMMAND";
const PRIVATE_THREAD_ID = "thread-private-native-approval";
const PRIVATE_ITEM_ID = "item-private-native-approval";

let instance: OpenClawTestInstance | undefined;

type AppServerLogEntry = {
  id?: number | string;
  method?: string;
  result?: unknown;
};

type PendingApproval = {
  id: string;
  request?: {
    allowedDecisions?: string[];
    toolCallId?: string;
    toolName?: string;
  };
};

type ApprovalIdentityRow = {
  source_agent_id: string | null;
  source_session_key: string | null;
  source_run_id: string | null;
  source_tool_call_id: string | null;
  source_tool_name: string | null;
  source_context_id: string | null;
  source_execution_id: string | null;
};

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await instance?.cleanup();
  instance = undefined;
});

function readJsonLines(filePath: string): AppServerLogEntry[] {
  try {
    return readFileSync(filePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line: string) => JSON.parse(line) as AppServerLogEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function queryApproval(owner: OpenClawTestInstance, sql: string, ...args: string[]) {
  const database = new DatabaseSync(path.join(owner.stateDir, "state", "openclaw.sqlite"), {
    readOnly: true,
  });
  try {
    return database.prepare(sql).get(...args);
  } finally {
    database.close();
  }
}

function readApprovalIdentity(testInstance: OpenClawTestInstance, approvalId: string) {
  return queryApproval(
    testInstance,
    `SELECT approval.source_agent_id, approval.source_session_key, approval.source_run_id,
            approval.source_tool_call_id, approval.source_tool_name,
            binding.source_context_id, binding.source_execution_id
       FROM operator_approvals AS approval
       LEFT JOIN operator_approval_execution_identities AS binding
         ON binding.approval_id = approval.approval_id
      WHERE approval.approval_id = ?`,
    approvalId,
  ) as ApprovalIdentityRow | undefined;
}

function assertNoGenericDuplicate(testInstance: OpenClawTestInstance, approvalId: string) {
  const table = queryApproval(
    testInstance,
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?",
    "execution_decision_facts",
  );
  if (table) {
    const row = queryApproval(
      testInstance,
      `SELECT COUNT(*) AS count FROM execution_decision_facts
        WHERE owner = 'operator_approvals' OR source_ref = (
          SELECT resolution_ref FROM operator_approvals WHERE approval_id = ?
        )`,
      approvalId,
    );
    expect(row?.count).toBe(0);
  }
}

function requireAllowedOnceReceipt(result: AuditRunInspectResult) {
  const receipt = result.decisionDisplays.find(
    (candidate) =>
      candidate.provenance.state === "verified" &&
      candidate.provenance.producer === "operator-approval",
  );
  expect(receipt).toMatchObject({
    decision: {
      outcome: "allowed",
      reasonCode: "operator_approval_allowed_once",
    },
    enforcement: {
      coverageState: "enforced",
      contextFieldsUsed: ["contextId", "executionId", "runId"],
    },
    provenance: { state: "verified", producer: "operator-approval" },
  });
}

function summarizeAppServerLog(filePath: string) {
  return readJsonLines(filePath).map((entry) =>
    entry.id === "approval-private-native-approval"
      ? { id: entry.id, method: entry.method, result: entry.result }
      : { id: entry.id, method: entry.method },
  );
}

async function connectApprovalReviewer(testInstance: OpenClawTestInstance) {
  const connected = createDeferred();
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${testInstance.port}`,
    token: testInstance.gatewayToken,
    clientName: "gateway-client",
    clientDisplayName: "Codex native approval reviewer",
    deviceIdentity: null,
    mode: "backend",
    caps: ["plugin-approvals"],
    scopes: ["operator.admin"],
    onHelloOk: () => connected.resolve(),
    onConnectError: connected.reject,
    onClose: (code, reason) =>
      connected.reject(new Error(`approval reviewer closed (${code}): ${reason}`)),
  });
  const readiness = await startGatewayClientWhenEventLoopReady(client, { timeoutMs: 20_000 });
  if (!readiness.ready) {
    client.stop();
    throw new Error("approval reviewer did not reach event-loop readiness");
  }
  await connected.promise;
  return client;
}

async function inspectReceipt(owner: OpenClawTestInstance, runId: string, approvalId: string) {
  const result = await owner.cli(["audit", "--run", runId, "--explain", "--json"]);
  expect(result.code, result.stderr).toBe(0);
  const inspection = JSON.parse(result.stdout) as AuditRunInspectResult;
  requireAllowedOnceReceipt(inspection);
  assertNoGenericDuplicate(owner, approvalId);
  return JSON.stringify(inspection);
}

describe("Codex native approval receipt", () => {
  it(
    "preserves a native command approval and its exact receipt across Gateway restart",
    { timeout: 180_000 },
    async ({ signal }) => {
      const { CODEX_APP_SERVER_VERSION } = await loadBundledPluginFacade<{
        CODEX_APP_SERVER_VERSION: string;
      }>({ pluginId: "codex", artifactBasename: "test-api.js" });
      const fixture = fileURLToPath(
        new URL("./codex-native-approval-app-server.fixture.mjs", import.meta.url),
      );
      const appServer = {
        mode: "guardian",
        command: process.execPath,
        args: [fixture],
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
      };
      instance = await createOpenClawTestInstance({
        name: "qa-codex-native-approval-receipt",
        env: {
          OPENCLAW_AGENT_HARNESS_FALLBACK: "none",
          OPENCLAW_QA_CODEX_APP_SERVER_VERSION: CODEX_APP_SERVER_VERSION,
          OPENCLAW_SKIP_PROVIDERS: undefined,
          // Native task admission needs the configured owner published by full Gateway startup.
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        },
        config: {
          logging: { audit: { enabled: true, executionIdentity: true } },
          tools: { exec: { mode: "ask" } },
          plugins: {
            allow: ["codex"],
            entries: { codex: { enabled: true, config: { appServer } } },
          },
          agents: {
            defaults: {
              model: { primary: MODEL, fallbacks: [] },
              models: { [MODEL]: { agentRuntime: { id: "codex" } } },
              workspace: "~/workspace",
              skipBootstrap: true,
              timeoutSeconds: 60,
            },
          },
        },
      });

      const appServerLogPath = instance.state.path("codex-native-approval-app-server.jsonl");
      instance.env.OPENCLAW_QA_CODEX_NATIVE_APPROVAL_LOG = appServerLogPath;
      writePersistedAuthProfileStoreRaw(
        {
          version: 1,
          profiles: {
            "openai:qa-oauth": {
              type: "oauth",
              provider: "openai",
              access: "test-native-approval-oauth",
              refresh: "test-refresh",
              expires: Date.UTC(2036, 0, 1),
              accountId: "qa-codex-native-approval",
            },
          },
          order: { openai: ["openai:qa-oauth"] },
        },
        instance.state.agentDir(),
      );
      await closeOpenClawAgentDatabasesAsync();
      await instance.startGateway();
      const reviewer = await connectApprovalReviewer(instance);

      try {
        const started = await reviewer.request<{ runId?: string; status?: string }>(
          "chat.send",
          {
            sessionKey: "agent:main:c03-native-approval",
            message: "Complete the deterministic native approval fixture.",
            deliver: false,
            idempotencyKey: randomUUID(),
          },
          { timeoutMs: 30_000 },
        );
        expect(started.status).toBe("started");
        expect(started.runId).toEqual(expect.any(String));

        let approval: PendingApproval;
        try {
          approval = await vi.waitFor(
            async () => {
              const pending = await reviewer.request<PendingApproval[]>("plugin.approval.list", {});
              const match = pending[0];
              expect(match).toBeDefined();
              if (!match) {
                throw new Error("native approval is not pending yet");
              }
              return match;
            },
            { interval: 50, timeout: REQUEST_TIMEOUT_MS },
          );
        } catch (error) {
          throw new Error(
            `native approval did not become pending; app-server=${JSON.stringify(summarizeAppServerLog(appServerLogPath))}\n${instance.logs()}`,
            { cause: error },
          );
        }
        expect(approval.request).toMatchObject({
          allowedDecisions: ["allow-once", "deny"],
          toolCallId: PRIVATE_ITEM_ID,
          toolName: "codex_command_approval",
        });

        await reviewer.request("plugin.approval.resolve", {
          id: approval.id,
          decision: "allow-once",
        });
        await expect(
          withinTest(
            reviewer.request(
              "agent.wait",
              { runId: started.runId, timeoutMs: REQUEST_TIMEOUT_MS },
              { timeoutMs: REQUEST_TIMEOUT_MS + 5_000 },
            ),
            signal,
          ),
        ).resolves.toMatchObject({ status: "ok" });
        // The fixture records the decision before sending turn/completed, which agent.wait joins.
        const response = readJsonLines(appServerLogPath).find(
          (entry) => entry.id === "approval-private-native-approval" && entry.result !== undefined,
        );
        expect(response?.result).toEqual({ decision: "accept" });

        const identity = readApprovalIdentity(instance, approval.id);
        expect(identity).toMatchObject({
          source_agent_id: "main",
          source_tool_call_id: PRIVATE_ITEM_ID,
          source_tool_name: "codex_command_approval",
          source_session_key: "agent:main:c03-native-approval",
          source_run_id: started.runId,
          source_context_id: expect.any(String),
          source_execution_id: expect.any(String),
        });
        if (!identity?.source_run_id) {
          throw new Error("operator approval omitted the admitted run id");
        }
        const sourceRunId = identity.source_run_id;

        const serialized = await inspectReceipt(instance, sourceRunId, approval.id);
        expect(serialized).not.toContain(PRIVATE_COMMAND);
        expect(serialized).not.toContain(PRIVATE_THREAD_ID);
        expect(serialized).not.toContain(PRIVATE_ITEM_ID);
        expect(serialized).not.toContain(process.cwd());

        reviewer.stop();
        await instance.stopGateway();
        await instance.startGateway();
        expect(await inspectReceipt(instance, sourceRunId, approval.id)).toBe(serialized);
      } finally {
        reviewer.stop();
      }
    },
  );
});
