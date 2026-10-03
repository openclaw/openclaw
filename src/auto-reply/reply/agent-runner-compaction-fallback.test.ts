import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import {
  getSessionMcpRuntimeManagerForTesting,
  setSessionMcpRuntimeScheduler,
} from "../../agents/agent-bundle-mcp-manager-api.js";
import { waitForSessionMaintenance } from "../../agents/session-maintenance/coordinator.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../../agents/test-helpers/assistant-message-fixtures.js";
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
import { runReplyAgent } from "./agent-runner.js";
import { createTestFollowupRun } from "./agent-runner.test-fixtures.js";
import { createTypingController } from "./typing.js";

// Real reply turns: preflight compaction, the native compaction delegate, and the
// foreground run all reach a local OpenAI-compatible provider. Only summary requests stall.
it("answers through a stalled compaction summary and does not re-run it next turn", async () => {
  await withOpenClawTestState({ label: "compaction-summary-fallback" }, async (state) => {
    let summaryRequests = 0;
    let answers = 0;
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        // Built-in summarization requests carry SUMMARIZATION_SYSTEM_PROMPT.
        if (body.includes("context summarization assistant")) {
          summaryRequests += 1;
          response.writeHead(200, { "content-type": "text/event-stream" });
          return;
        }
        answers += 1;
        const chunk = (payload: object) =>
          `data: ${JSON.stringify({ id: "answer", object: "chat.completion.chunk", created: 1, model: "test-model", ...payload })}\n\n`;
        response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
        response.end(
          chunk({
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: `ANSWER-${answers}` },
                finish_reason: null,
              },
            ],
          }) +
            chunk({
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 3_000, completion_tokens: 5, total_tokens: 3_005 },
            }) +
            "data: [DONE]\n\n",
        );
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
        list: [{ id: "main", default: true, workspace: state.workspaceDir }],
        defaults: {
          workspace: state.workspaceDir,
          model: { primary: "test-provider/test-model" },
          compaction: { timeoutSeconds: 5, keepRecentTokens: 2_000 },
        },
      },
      session: { store: storePath },
      models: {
        providers: {
          "test-provider": {
            api: "openai-completions",
            apiKey: "synthetic-test-key",
            baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
            models: [
              {
                id: "test-model",
                name: "Synthetic model",
                reasoning: false,
                input: ["text"],
                contextWindow: 32_768,
                contextTokens: 32_768,
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
        totalTokens: 30_000,
        totalTokensFresh: true,
        totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
      });
      const seed = SessionManager.open(scope, state.workspaceDir);
      for (let turn = 0; turn < 12; turn += 1) {
        seed.appendMessage({
          role: "user",
          content: `Earlier question ${turn}. ${"Background detail. ".repeat(250)}`,
          timestamp: turn + 1,
        });
        seed.appendMessage(
          makeAssistantMessageFixture({
            provider: "test-provider",
            api: "openai-completions",
            model: "test-model",
            content: [{ type: "text", text: `Earlier answer ${turn}.` }],
            stopReason: "stop",
            errorMessage: undefined,
            usage: {
              input: 30_000,
              output: 5,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 30_005,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
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
        return await runReplyAgent({
          commandBody: prompt,
          transcriptCommandBody: prompt,
          followupRun,
          queueKey: sessionKey,
          resolvedQueue: { mode: "interrupt" },
          shouldSteer: false,
          shouldFollowup: false,
          isActive: false,
          opts: { runId },
          typing: createTypingController({}),
          sessionCtx: { Provider: "webchat", MessageSid: runId, SessionKey: sessionKey },
          sessionEntry: entry,
          sessionStore: { [sessionKey]: entry },
          sessionKey,
          storePath,
          defaultModel: "test-model",
          resolvedVerboseLevel: "off",
          isNewSession: false,
          blockStreamingEnabled: false,
          resolvedBlockStreamingBreak: "message_end",
          shouldInjectGroupIntro: false,
          typingMode: "never",
        });
      };

      expect(await turn("First question after the long history.", "turn-1")).toMatchObject({
        text: "ANSWER-1",
      });
      expect(summaryRequests, "the summary request was never sent").toBeGreaterThan(0);
      const compactions = (await loadTranscriptEvents(scope))
        .map(asOptionalRecord)
        .filter((event) => event?.type === "compaction");
      expect(compactions).toHaveLength(1);
      expect(compactions[0]?.summary).toContain("removed without a summary");
      expect(loadSessionEntry(scope)?.compactionCount).toBe(1);

      const summariesAfterFirstTurn = summaryRequests;
      expect(await turn("Second question.", "turn-2")).toMatchObject({ text: "ANSWER-2" });
      expect(summaryRequests).toBe(summariesAfterFirstTurn);
      expect(loadSessionEntry(scope)?.compactionCount).toBe(1);
    } finally {
      await waitForSessionMaintenance(sessionKey);
      const mcpManager = getSessionMcpRuntimeManagerForTesting();
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
}, 120_000);
