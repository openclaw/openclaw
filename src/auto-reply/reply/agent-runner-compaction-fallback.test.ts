import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { writeOpenAiResponsesItem } from "../../../test/helpers/openai-responses-item.test-support.js";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.js";
import { setSessionMcpRuntimeScheduler } from "../../agents/agent-bundle-mcp-manager-api.js";
import { getSessionMcpRuntimeTestManager } from "../../agents/agent-bundle-mcp-manager.test-support.js";
import { waitForSessionMaintenance } from "../../agents/session-maintenance/coordinator.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../../agents/test-helpers/assistant-message-fixtures.js";
import { createUsageFixture } from "../../agents/test-helpers/usage-fixtures.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../../config/sessions.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runReplyAgent } from "./agent-runner-run.js";
import { createTestFollowupRun } from "./agent-runner.test-fixtures.js";
import { createReplyParams } from "./test-helpers.js";
import { createTypingController } from "./typing.js";

// Real reply/session/attempt owners reach a deterministic local provider. The
// Responses tool loop must compact before the next oversized request; the
// completions case keeps its timed-out-summary recovery across turns.
it.each([false, true])(
  "answers after compaction without repeating it next turn (tool rounds: %s)",
  async (midTurn) => {
    await withOpenClawTestState({ label: "compaction-summary-fallback" }, async (state) => {
      let summaryRequests = 0;
      let answers = 0;
      let toolRounds = 0;
      let overWindow = 0;
      let summariesBeforeAnswer = 0;
      let largestPrompt = 0;
      let publishedBeforeSummary = 0;
      const contextWindow = midTurn ? 1_000_000 : 32_768;
      const reportPath = path.join(state.workspaceDir, "report.txt");
      await writeFile(reportPath, "Project evidence row.\n".repeat(1_800));
      const server = createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => {
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
          if (summaryRequests === 0) {
            publishedBeforeSummary = Math.max(
              publishedBeforeSummary,
              loadSessionEntry(scope)?.totalTokens ?? 0,
            );
          }
          largestPrompt = Math.max(largestPrompt, tokens);
          if (midTurn && tokens + (wire.max_output_tokens ?? 4_096) > contextWindow) {
            overWindow += 1;
            response.writeHead(400, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                error: { message: "Your input exceeds the context window of this model." },
              }),
            );
            return;
          }
          // Built-in summarization requests carry SUMMARIZATION_SYSTEM_PROMPT.
          if (body.includes("context summarization assistant")) {
            summaryRequests += 1;
            if (midTurn) {
              writeOpenAiResponsesText(response, {
                text: "Earlier report evidence summarized; finish the task.",
                messageId: "summary",
                responseId: "response-summary",
              });
              return;
            }
            response.writeHead(408, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { message: "upstream request timed out" } }));
            return;
          }
          const toolCall = midTurn && summaryRequests === 0 && toolRounds < 64;
          if (toolCall) {
            toolRounds += 1;
          } else {
            answers += 1;
            summariesBeforeAnswer = summaryRequests;
          }
          const usage = {
            input_tokens: midTurn ? tokens : 3_000,
            output_tokens: 5,
            total_tokens: (midTurn ? tokens : 3_000) + 5,
          };
          if (!midTurn) {
            response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
            response.end(
              `data: ${JSON.stringify({ id: "answer", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta: { role: "assistant", content: `ANSWER-${answers}` }, finish_reason: "stop" }], usage: { prompt_tokens: 3_000, completion_tokens: 5, total_tokens: 3_005 } })}\n\ndata: [DONE]\n\n`,
            );
          } else if (toolCall) {
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
            writeOpenAiResponsesText(response, {
              text: `ANSWER-${answers}`,
              messageId: `answer-${answers}`,
              responseId: `response-answer-${answers}`,
              usage,
            });
          }
        });
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const sessionKey = "agent:main:main";
      const sessionId = "compaction-summary-fallback";
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const scope = { agentId: "main", sessionKey, sessionId, storePath };
      const cfg: OpenClawConfig = {
        agents: {
          entries: { main: { workspace: state.workspaceDir } },
          defaults: {
            workspace: state.workspaceDir,
            model: { primary: "test-provider/test-model" },
            compaction: { keepRecentTokens: 2_000, memoryFlush: { enabled: false } },
          },
        },
        ...(midTurn ? { tools: { allow: ["read"], codeMode: false, toolSearch: false } } : {}),
        session: { store: storePath },
        models: {
          providers: {
            "test-provider": {
              api: midTurn ? "openai-responses" : "openai-completions",
              apiKey: "synthetic-test-key",
              baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
              models: [
                {
                  id: "test-model",
                  name: "Synthetic model",
                  reasoning: false,
                  input: ["text"],
                  contextWindow,
                  contextTokens: contextWindow,
                  maxTokens: 4_096,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      };
      const scheduler = createTestGatewayScheduler();
      try {
        await setSessionMcpRuntimeScheduler(scheduler);
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg);
        await replaceSessionEntry(scope, {
          sessionId,
          updatedAt: Date.now(),
          totalTokens: midTurn ? 560_000 : 30_000,
          totalTokensFresh: true,
          totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
        });
        const seed = await SessionManager.openAsync(scope, state.workspaceDir);
        for (let turn = 0; turn < (midTurn ? 56 : 12); turn += 1) {
          await seed.appendMessageAsync({
            role: "user",
            content: `Earlier question ${turn}. ${"Background detail. ".repeat(midTurn ? 2_200 : 250)}`,
            timestamp: turn + 1,
          });
          await seed.appendMessageAsync(
            makeAssistantMessageFixture({
              provider: "test-provider",
              api: midTurn ? "openai-responses" : "openai-completions",
              model: "test-model",
              content: [{ type: "text", text: `Earlier answer ${turn}.` }],
              stopReason: "stop",
              errorMessage: undefined,
              usage: createUsageFixture(midTurn ? 560_000 : 30_000, 5, midTurn ? 560_005 : 30_005),
            }),
          );
        }
        const turn = async (prompt: string, runId: string) => {
          const followupRun = createTestFollowupRun({
            agentId: "main",
            agentDir: state.agentDir(),
            sessionId,
            sessionKey,
            sessionFile: sessionKey,
            workspaceDir: state.workspaceDir,
            config: cfg,
            provider: "test-provider",
            model: "test-model",
            messageProvider: "webchat",
            thinkLevel: "off",
            timeoutMs: 60_000,
            senderIsOwner: true,
          });
          followupRun.prompt = prompt;
          const entry = loadSessionEntry(scope)!;
          return await runReplyAgent(
            createReplyParams(followupRun, {
              commandBody: prompt,
              transcriptCommandBody: prompt,
              queueKey: sessionKey,
              opts: { runId },
              typing: createTypingController({}),
              sessionCtx: { Provider: "webchat", MessageSid: runId, SessionKey: sessionKey },
              sessionEntry: entry,
              sessionStore: { [sessionKey]: entry },
              sessionKey,
              storePath,
              defaultModel: "test-model",
            }),
          );
        };

        expect(await turn("First question after the long history.", "turn-1")).toMatchObject({
          text: "ANSWER-1",
        });
        expect(overWindow, "the provider received an over-window request").toBe(0);
        expect(summaryRequests).toBeGreaterThan(0);
        if (midTurn) {
          expect(toolRounds).toBeGreaterThan(1);
          expect(summariesBeforeAnswer).toBeGreaterThan(0);
          expect(largestPrompt).toBeLessThan(800_000);
          expect(publishedBeforeSummary).toBeGreaterThan(700_000);
        }
        const compactions = (await loadTranscriptEvents(scope))
          .map(asOptionalRecord)
          .filter((event) => event?.type === "compaction");
        expect(compactions).toHaveLength(1);
        expect(compactions[0]?.summary).toContain(
          midTurn ? "Earlier report evidence summarized" : "removed without a summary",
        );
        const summariesAfterFirstTurn = summaryRequests;
        expect(await turn("Second question.", "turn-2")).toMatchObject({ text: "ANSWER-2" });
        expect(summaryRequests).toBe(summariesAfterFirstTurn);
        expect(loadSessionEntry(scope)?.compactionCount).toBe(1);
      } finally {
        await waitForSessionMaintenance(sessionKey);
        const mcpManager = getSessionMcpRuntimeTestManager();
        for (const runtimeSessionId of mcpManager.listSessionIds()) {
          await mcpManager.disposeSession(runtimeSessionId);
        }
        await scheduler.stop();
        clearRuntimeConfigSnapshot();
        server.closeAllConnections();
        server.close();
        await once(server, "close");
      }
    });
  },
  120_000,
);
