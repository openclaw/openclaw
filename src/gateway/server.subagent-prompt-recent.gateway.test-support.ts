// Isolated-gateway two-turn parent-agent/model trace. A real in-process
// gateway plus mock OpenAI Responses provider runs two parent agent turns.
// Between them a keep-cleanup child reaches terminal on the live registry.
// The later model request is the assembled system prompt the parent sees.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { persistSubagentRunsToDiskOrThrow } from "../agents/subagents/registry/subagent-registry-state.js";
import { loadSubagentRunsByRunIdsFromSqlite } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import {
  listSubagentRunsForRequester,
  registerSubagentRun,
  resetSubagentRegistryForTests,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { resetConfigOverrides } from "../config/runtime-overrides.js";
import { resolvePhysicalSessionStorePath } from "../config/sessions/session-store-path.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const ENV_KEYS = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
  "OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE",
] as const;

const RUN_ID = "run-gw-prompt-recent";
const CHILD_SESSION_KEY = "agent:main:subagent:gw-prompt-recent";
const PARENT_SESSION_KEY = "agent:main:main";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function resetGatewayState(): void {
  resetConfigOverrides();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest({ preserveListeners: true });
  resetSubagentRegistryForTests({ persist: false });
}

afterEach(resetGatewayState);

function excerptRecentlyCompleted(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  const start = raw.indexOf("## Recently Completed Subagents");
  return start >= 0 ? raw.slice(start, start + 700) : null;
}

async function runParentAgentTurn(
  client: Awaited<ReturnType<typeof startGatewayWithClient>>["client"],
  message: string,
  sessionKey = PARENT_SESSION_KEY,
): Promise<void> {
  const runId = randomUUID();
  const accepted = await client.request<{ runId?: string; status?: string }>("agent", {
    sessionKey,
    message,
    deliver: false,
    idempotencyKey: runId,
  });
  expect(accepted.status).toBe("accepted");
  const completed = await client.request<{ status?: string }>(
    "agent.wait",
    { runId: accepted.runId ?? runId, timeoutMs: 30_000 },
    { timeoutMs: 35_000 },
  );
  expect(completed.status).toBe("ok");
}

describe("Completed child results on a real parent-agent turn", () => {
  test.each(["lifecycle", "outstanding"] as const)(
    "later parent model request includes the completed child: %s",
    { timeout: 90_000 },
    async (kind) => {
      const env = captureEnv([...ENV_KEYS]);
      const home = tempDirs.make("openclaw-gw-subagent-prompt-recent-");
      const stateDir = path.join(home, ".openclaw");
      const workspace = path.join(home, "workspace");
      const bundledPluginsDir = path.join(home, "empty-bundled-plugins");
      const configPath = path.join(stateDir, "openclaw.json");
      await Promise.all([
        fs.mkdir(workspace, { recursive: true }),
        fs.mkdir(bundledPluginsDir, { recursive: true }),
        fs.mkdir(stateDir, { recursive: true }),
      ]);
      for (const [key, value] of Object.entries({
        HOME: home,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1",
      })) {
        setTestEnvValue(key, value);
      }
      deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
      deleteTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY");
      resetGatewayState();

      const requests: string[] = [];
      const providerServer = createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          requests.push(Buffer.concat(chunks).toString("utf8"));
          const message = {
            type: "message",
            id: randomUUID(),
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "ok", annotations: [] }],
          };
          response.writeHead(200, { "content-type": "text/event-stream" });
          for (const event of [
            {
              type: "response.output_item.added",
              item: { ...message, status: "in_progress", content: [] },
            },
            { type: "response.output_item.done", item: message },
            {
              type: "response.completed",
              response: {
                status: "completed",
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            },
          ]) {
            response.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          response.end("data: [DONE]\n\n");
        })().catch((error: unknown) => response.writeHead(500).end(String(error)));
      });

      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          providerServer.once("error", reject);
          providerServer.listen(0, "127.0.0.1", resolve);
        });
        const address = providerServer.address();
        if (!address || typeof address === "string") {
          throw new Error("mock provider did not bind");
        }
        const provider = buildMockOpenAiResponsesProvider(
          `http://127.0.0.1:${address.port}/v1`,
          "prompt-recent",
        );
        const token = `prompt-recent-${process.pid}`;
        const cfg = {
          agents: {
            defaults: {
              workspace,
              skipBootstrap: true,
              heartbeat: { every: "0m" },
              model: { primary: provider.modelRef },
              models: {
                [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
              },
            },
          },
          gateway: { auth: { mode: "token", token } },
          hooks: { enabled: false },
          models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
          plugins: { slots: { memory: "none" } },
          tools: {
            profile: "coding",
            ...(kind === "outstanding" ? { deny: ["sessions_spawn"] } : {}),
          },
        } satisfies OpenClawConfig;

        gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token,
          clientDisplayName: "vitest-subagent-prompt-recent",
        });

        const firstCursor = requests.length;
        await runParentAgentTurn(gateway.client, "first parent turn");
        const firstParentTurn = requests.slice(firstCursor).join("\n");
        expect(firstParentTurn).not.toContain("## Recently Completed Subagents");

        if (kind === "outstanding") {
          const result = `Retained-result-${randomUUID()}`;
          const endedAt = Date.now() - 7_200_000;
          const retained: SubagentRunRecord = {
            runId: "persisted-outstanding-result",
            childSessionKey: CHILD_SESSION_KEY,
            requesterSessionKey: PARENT_SESSION_KEY,
            requesterStorePath: resolvePhysicalSessionStorePath(
              { sessionKey: PARENT_SESSION_KEY },
              cfg,
            ),
            requesterAgentId: "main",
            requesterDisplayKey: "main",
            task: "read the retained result",
            cleanup: "keep",
            expectsCompletionMessage: true,
            createdAt: endedAt - 1_000,
            execution: { status: "terminal", endedAt, outcome: { status: "ok" } },
            completion: { required: true, resultText: result, capturedAt: endedAt },
            delivery: { status: "failed" },
          };
          // Publish retained custody through the owner without registering an active child.
          persistSubagentRunsToDiskOrThrow(new Map([[retained.runId, retained]]), [retained.runId]);
          const before = loadSubagentRunsByRunIdsFromSqlite([retained.runId]);
          const cursor = requests.length;
          await runParentAgentTurn(gateway.client, "Continue using any outstanding child result.");
          const parentRequest = requests.slice(cursor).join("\n");
          expect(parentRequest).toContain("## Child results awaiting delivery");
          expect(parentRequest).toContain(result);
          expect(parentRequest).not.toContain("## Recently Completed Subagents");
          expect(loadSubagentRunsByRunIdsFromSqlite([retained.runId])).toEqual(before);
          const unrelatedCursor = requests.length;
          await runParentAgentTurn(
            gateway.client,
            "Summarize this session.",
            "agent:main:unrelated",
          );
          expect(requests.slice(unrelatedCursor).join("\n")).not.toContain(result);
          console.log(
            `OPENCLAW_ISOLATED_GATEWAY_CATCHUP_VERDICT ${JSON.stringify({
              surface: "isolated-gateway",
              path: "real-parent-model-request",
              source: "seeded-registry-owner-result",
              result,
              resultAgeMs: 7_200_000,
              spawnDenied: true,
              heartbeatDisabled: true,
              requesterSawResult: true,
              unrelatedRequesterSawResult: false,
              deliveryStateUnchanged: true,
            })}`,
          );
          return;
        }

        registerSubagentRun({
          runId: RUN_ID,
          childSessionKey: CHILD_SESSION_KEY,
          requesterSessionKey: PARENT_SESSION_KEY,
          requesterDisplayKey: "main",
          task: "summarize the inbox",
          taskName: "summarize_inbox",
          cleanup: "keep",
          expectsCompletionMessage: false,
        });
        const endedAt = Date.now();
        emitAgentEvent({
          runId: RUN_ID,
          stream: "lifecycle",
          data: {
            phase: "end",
            endedAt,
            terminalReply: { disposition: "visible", text: "done" },
          },
        });
        await expect
          .poll(
            () =>
              listSubagentRunsForRequester(PARENT_SESSION_KEY).find((row) => row.runId === RUN_ID)
                ?.execution.status,
          )
          .toBe("terminal");

        const laterCursor = requests.length;
        await runParentAgentTurn(gateway.client, "later parent turn");
        const laterParentTurn = requests.slice(laterCursor).join("\n");
        // The real completion owner may finish requester settlement before this
        // later turn starts. Both projections must preserve child discovery;
        // the persisted-outstanding case above separately pins pending custody.
        const hasOutstanding = laterParentTurn.includes("## Child results awaiting delivery");
        const hasRecent = laterParentTurn.includes("## Recently Completed Subagents");
        expect(hasOutstanding || hasRecent).toBe(true);
        expect(laterParentTurn).toContain(RUN_ID);
        expect(laterParentTurn).toContain(CHILD_SESSION_KEY);
        expect(laterParentTurn).not.toContain("## Active Subagents");

        const verdict = {
          surface: "isolated-gateway",
          path: "parent-agent-model-turn",
          firstParentTurn: { assembledPrompt: excerptRecentlyCompleted(firstParentTurn) },
          completion: { runId: RUN_ID, terminal: true },
          laterParentTurn: {
            hasOutstandingRequesterContinuation: hasOutstanding,
            hasRecentlyCompleted: hasRecent,
            runId: RUN_ID,
          },
        };
        console.log(`OPENCLAW_ISOLATED_GATEWAY_VERDICT ${JSON.stringify(verdict)}`);
      } finally {
        if (gateway) {
          await disconnectGatewayClient(gateway.client).catch(() => undefined);
          await gateway.server.close({ reason: "subagent prompt recent proof complete" });
        }
        providerServer.closeAllConnections();
        await new Promise<void>((resolve) => {
          providerServer.close(() => resolve());
        });
        env.restore();
      }
    },
  );
});
