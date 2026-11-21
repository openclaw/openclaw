import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it } from "vitest";
import { writeOpenAiResponsesItem } from "../../test/helpers/openai-responses-item.test-support.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../agents/test-helpers/assistant-message-fixtures.js";
import { createUsageFixture } from "../agents/test-helpers/usage-fixtures.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../config/sessions/types.js";
import { resetGatewayTestState } from "../gateway/gateway.test-support.js";
import type { GatewaySessionRow, SessionsListResult } from "../gateway/session-utils.types.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../gateway/test-helpers.e2e.js";
import { createAuthorityGatewayTestEnv } from "../gateway/test-helpers.env.js";
import { buildMockOpenAiResponsesProvider } from "../gateway/test-openai-responses-model.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import type { CronRunLogEntry } from "./run-log-types.js";
import type { CronJob } from "./types.js";

afterEach(resetGatewayTestState);

// Public cron dispatch must publish context even when scheduled input preserves
// the conversation's user-facing activity. No runner or session reader is mocked.
it(
  "publishes completed and growing scheduled context through sessions.list",
  { timeout: 120_000 },
  async ({ signal }) => {
    await withOpenClawTestState(
      {
        label: "scheduled-context-accounting",
        env: { ...createAuthorityGatewayTestEnv(), OPENCLAW_SKIP_CRON: undefined },
      },
      async (state) => {
        const shortKey = "agent:main:scheduled-accounting";
        const longKey = "agent:main:scheduled-compaction";
        const storePath = path.join(state.sessionsDir(), "sessions.json");
        const interactionAt = Date.now() - 10_000;
        const reportPath = path.join(state.workspaceDir, "report.txt");
        await writeFile(reportPath, "Project evidence row.\n".repeat(1_800));
        let longTurn = false;
        let summaryRequests = 0;
        let toolRounds = 0;
        let overWindow = 0;
        let largestPrompt = 0;
        let publishedBeforeSummary = 0;
        let lastAnswerTokens = 0;
        let listRow: ((key: string) => Promise<GatewaySessionRow | undefined>) | undefined;
        const providerWork: Promise<void>[] = [];
        const { listener, claim, releaseListener } = await reserveTestPortListener({
          offsets: [0],
          signal,
          createListener: () =>
            createServer((request, response) => {
              const work = (async () => {
                let body = "";
                for await (const chunk of request) {
                  body += String(chunk);
                }
                const wire = JSON.parse(body) as {
                  input: unknown[];
                  instructions?: string;
                  tools?: unknown[];
                  max_output_tokens?: number;
                };
                const tokens = Math.ceil(
                  JSON.stringify({
                    input: wire.input,
                    instructions: wire.instructions,
                    tools: wire.tools,
                  }).length / 4,
                );
                largestPrompt = Math.max(largestPrompt, tokens);
                if (tokens + (wire.max_output_tokens ?? 4_096) > 1_000_000) {
                  overWindow += 1;
                  response.writeHead(400, { "content-type": "application/json" });
                  response.end(
                    JSON.stringify({ error: { message: "Input exceeds context window" } }),
                  );
                  return;
                }
                if (longTurn && summaryRequests === 0) {
                  const row = await expectDefined(listRow, "connected list reader")(longKey);
                  publishedBeforeSummary = Math.max(publishedBeforeSummary, row?.totalTokens ?? 0);
                }
                if (body.includes("context summarization assistant")) {
                  summaryRequests += 1;
                  writeOpenAiResponsesText(response, {
                    text: "Earlier report evidence summarized; finish the scheduled task.",
                    messageId: "summary",
                    responseId: "response-summary",
                  });
                  return;
                }
                const usage = {
                  input_tokens: longTurn ? tokens : 3_000,
                  output_tokens: 5,
                  total_tokens: (longTurn ? tokens : 3_000) + 5,
                };
                if (longTurn && summaryRequests === 0 && toolRounds < 64) {
                  toolRounds += 1;
                  writeOpenAiResponsesItem(
                    response,
                    `response-${toolRounds}`,
                    {
                      type: "function_call",
                      id: `fc-${toolRounds}`,
                      call_id: `read-${toolRounds}`,
                      name: "read",
                      arguments: JSON.stringify({ path: reportPath, offset: 1 + toolRounds * 10 }),
                    },
                    usage,
                  );
                } else {
                  lastAnswerTokens = usage.total_tokens;
                  writeOpenAiResponsesText(response, {
                    text: "Scheduled task complete.",
                    messageId: "answer",
                    responseId: "response-answer",
                    usage,
                  });
                }
              })();
              providerWork.push(work);
              void work.catch((error: unknown) =>
                response.destroy(error instanceof Error ? error : new Error(String(error))),
              );
            }),
        });
        let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
        try {
          const provider = buildMockOpenAiResponsesProvider(
            `http://127.0.0.1:${claim.port}/v1`,
            "gpt-4.1",
          );
          provider.config.models[0].contextWindow = 1_000_000;
          for (const [sessionKey, totalTokens] of [
            [shortKey, 123],
            [longKey, 560_000],
          ] as const) {
            await replaceSessionEntry(
              { agentId: "main", sessionKey, storePath },
              {
                sessionId: sessionKey.split(":").at(-1)!,
                updatedAt: interactionAt,
                lastInteractionAt: interactionAt,
                visibility: "shared",
                totalTokens,
                totalTokensFresh: true,
                totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
              },
            );
          }
          const seed = await SessionManager.openAsync(
            {
              agentId: "main",
              sessionKey: longKey,
              sessionId: "scheduled-compaction",
              storePath,
            },
            state.workspaceDir,
          );
          for (let turn = 0; turn < 56; turn++) {
            await seed.appendMessageAsync({
              role: "user",
              content: `Earlier question ${turn}. ${"Background detail. ".repeat(2_200)}`,
              timestamp: turn + 1,
            });
            await seed.appendMessageAsync(
              makeAssistantMessageFixture({
                provider: provider.providerId,
                api: "openai-responses",
                model: provider.modelId,
                content: [{ type: "text", text: `Earlier answer ${turn}.` }],
                stopReason: "stop",
                errorMessage: undefined,
                usage: createUsageFixture(560_000, 5, 560_005),
              }),
            );
          }
          gateway = await startGatewayWithClient({
            configPath: state.configPath,
            token: "synthetic-cron-context-token",
            scopes: ["operator.admin"],
            cfg: {
              gateway: {
                mode: "local",
                auth: { mode: "token", token: "synthetic-cron-context-token" },
              },
              agents: {
                entries: { main: {} },
                defaults: {
                  workspace: state.workspaceDir,
                  skipBootstrap: true,
                  model: provider.modelRef,
                  models: {
                    [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
                  },
                  compaction: { keepRecentTokens: 2_000, memoryFlush: { enabled: false } },
                },
              },
              session: { store: storePath },
              models: {
                mode: "replace",
                catalogRefresh: { enabled: false },
                providers: {
                  [provider.providerId]: {
                    ...provider.config,
                    agentRuntime: { id: "openclaw" },
                    request: { allowPrivateNetwork: true },
                  },
                },
              },
              tools: { allow: ["read"], codeMode: false, toolSearch: false },
              plugins: { enabled: false, slots: { memory: "none" } },
              cron: { enabled: false },
              update: { checkOnStart: false },
            },
          });
          const { client } = gateway;
          await gateway.server.startupSettled;
          listRow = async (key) =>
            (
              await client.request<SessionsListResult>("sessions.list", {
                includeUnknown: true,
                includeGlobal: true,
                limit: 100,
              })
            ).sessions.find((row) => row.key === key);
          for (const sessionKey of [shortKey, longKey]) {
            longTurn = sessionKey === longKey;
            const before = expectDefined(await listRow(sessionKey), "seeded scheduled session");
            const job = await client.request<CronJob>("cron.add", {
              name: sessionKey,
              agentId: "main",
              enabled: false,
              schedule: { kind: "every", everyMs: 3_600_000 },
              sessionTarget: `session:${sessionKey}`,
              wakeMode: "now",
              delivery: { mode: "none" },
              payload: {
                kind: "agentTurn",
                message: "Read report evidence and finish the scheduled task.",
                thinking: "off",
              },
            });
            await client.request("cron.run", { id: job.id, mode: "force" });
            await expect
              .poll(
                async () =>
                  (
                    await client.request<{ entries: CronRunLogEntry[] }>("cron.runs", {
                      id: job.id,
                      limit: 1,
                    })
                  ).entries[0]?.status,
                { timeout: 60_000 },
              )
              .toBe("ok");
            const after = expectDefined(await listRow(sessionKey), "completed scheduled session");
            expect.soft(after.sessionId).toBe(before.sessionId);
            expect.soft(after.totalTokens).toBe(lastAnswerTokens);
            expect.soft(after.totalTokensFresh).toBe(true);
            console.info("scheduled context proof", {
              longTurn,
              before: before.totalTokens,
              after: after.totalTokens,
              reported: lastAnswerTokens,
              toolRounds,
              summaryRequests,
              largestPrompt,
              publishedBeforeSummary,
            });
          }
          expect(overWindow).toBe(0);
          expect(toolRounds).toBeGreaterThan(1);
          expect(summaryRequests).toBeGreaterThan(0);
          expect(largestPrompt).toBeLessThan(800_000);
          expect(publishedBeforeSummary).toBeGreaterThan(700_000);
        } finally {
          if (gateway) {
            await disconnectGatewayClient(gateway.client);
            await gateway.server.close({ reason: "scheduled context proof complete" });
          }
          listener.closeAllConnections();
          await releaseListener();
          await claim.release();
          await Promise.all(providerWork);
        }
      },
    );
  },
);
