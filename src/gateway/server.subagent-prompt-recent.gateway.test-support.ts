import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, expect, test } from "vitest";
import { readRequestText } from "../../test/helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import {
  loadSubagentRegistryFromSqlite,
  persistRegistryFixture,
} from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import {
  listSubagentRunsForRequester,
  registerSubagentRun,
  resetSubagentRegistryForTests,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { resolvePhysicalSessionStorePath } from "../config/sessions/session-store-path.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { withEnvAsync } from "../test-utils/env.js";
import { closeProvider, listenProvider } from "./gateway-provider-fixture.test-support.js";
import {
  createGatewayConfigPath,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const RUN_ID = "run-gw-prompt-recent";
const CHILD_SESSION_KEY = "agent:main:subagent:gw-prompt-recent";
const PARENT_SESSION_KEY = "agent:main:main";
async function resetGatewayState(): Promise<void> {
  resetGatewayTestState();
  await resetSubagentRegistryForTests({ persist: false });
}

afterEach(resetGatewayState);

async function runParentAgentTurn(
  client: Awaited<ReturnType<typeof startGatewayWithClient>>["client"],
  requests: string[],
  message: string,
  sessionKey = PARENT_SESSION_KEY,
): Promise<string> {
  const cursor = requests.length;
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
  return requests.slice(cursor).join("\n");
}

test.each(["lifecycle", "outstanding"] as const)(
  "later parent model request includes the completed child: %s",
  { timeout: 90_000 },
  async (kind) => {
    const {
      tempHome,
      workspaceDir: workspace,
      envSnapshot,
    } = await setupGatewayTempHome({
      prefix: "openclaw-gw-subagent-prompt-recent-",
    });
    try {
      const configPath = await createGatewayConfigPath(tempHome);
      await withEnvAsync({ OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" }, async () => {
        await resetGatewayState();

        const requests: string[] = [];
        const providerServer = createServer((request, response) => {
          void (async () => {
            requests.push(await readRequestText(request));
            writeOpenAiResponsesText(response, {
              text: "ok",
              messageId: randomUUID(),
              responseId: randomUUID(),
            });
          })().catch((error: unknown) => response.writeHead(500).end(String(error)));
        });

        let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
        try {
          const provider = buildMockOpenAiResponsesProvider(
            await listenProvider(providerServer),
            "prompt-recent",
          );
          const token = `prompt-recent-${process.pid}`;
          const cfg = {
            agents: {
              defaults: {
                workspace,
                skipBootstrap: true,
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
          await gateway.server.startupSettled;

          const turn = runParentAgentTurn.bind(null, gateway.client, requests);
          const firstParentTurn = await turn("first parent turn");
          expect(firstParentTurn).not.toContain("## Recently Completed Subagents");

          if (kind === "outstanding") {
            const result = `Retained-result-${randomUUID()}`;
            const endedAt = Date.now() - 7_200_000;
            const childSessionId = "persisted-outstanding-session";
            const retained: SubagentRunRecord = {
              runId: "persisted-outstanding-result",
              childSessionKey: CHILD_SESSION_KEY,
              childSessionIdentity: { sessionId: childSessionId },
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
              completion: {
                required: true,
                resultText: result,
                capturedAt: endedAt,
                terminalReply: { disposition: "visible", text: result },
              },
              delivery: { status: "failed" },
            };
            // The prompt consumes the registry receipt, not a child transcript or active child.
            persistRegistryFixture(new Map([[retained.runId, retained]]), [retained.runId]);
            const before = loadSubagentRegistryFromSqlite().get(retained.runId);
            const parentRequest = await turn("Continue using any outstanding child result.");
            expect(parentRequest).toContain("## Child results awaiting delivery");
            expect(parentRequest).toContain(result);
            expect(parentRequest).not.toContain("## Recently Completed Subagents");
            expect(loadSubagentRegistryFromSqlite().get(retained.runId)).toEqual(before);
            expect(await turn("Summarize this session.", "agent:main:unrelated")).not.toContain(
              result,
            );
            return;
          }

          await registerSubagentRun({
            runId: RUN_ID,
            childSessionKey: CHILD_SESSION_KEY,
            childAgentId: "main",
            sessionEntry: { sessionId: "gw-prompt-recent-child" },
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

          const laterParentTurn = await turn("later parent turn");
          // Settlement may finish first; either projection must preserve discovery.
          expect(laterParentTurn).toMatch(
            /## (Child results awaiting delivery|Recently Completed Subagents)/,
          );
          expect(laterParentTurn).toContain(RUN_ID);
          expect(laterParentTurn).toContain(CHILD_SESSION_KEY);
          expect(laterParentTurn).not.toContain("## Active Subagents");
        } finally {
          if (gateway) {
            await disconnectGatewayClient(gateway.client).catch(() => undefined);
            await gateway.server.close({ reason: "subagent prompt recent proof complete" });
          }
          await closeProvider(providerServer);
        }
      });
    } finally {
      envSnapshot.restore();
      await removeGatewayTempHome(tempHome);
    }
  },
);
