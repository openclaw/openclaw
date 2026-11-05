import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { text as readBody } from "node:stream/consumers";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../../test/helpers/gateway-integration-fixtures.js";
import {
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../../agents/admitted-run-context.js";
import { setSessionMcpRuntimeScheduler } from "../../agents/agent-bundle-mcp-manager-api.js";
import { getSessionMcpRuntimeTestManager } from "../../agents/agent-bundle-mcp-manager.test-support.js";
import { waitForSessionMaintenance } from "../../agents/session-maintenance/coordinator.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../../agents/test-helpers/assistant-message-fixtures.js";
import { ZERO_USAGE_FIXTURE } from "../../agents/test-helpers/usage-fixtures.js";
import { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } from "../../config/config.js";
import { SESSION_TOTAL_TOKENS_VERSION, type SessionEntry } from "../../config/sessions.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearMemoryPluginState } from "../../plugins/memory-state.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runReplyAgent } from "./agent-runner-run.js";
import {
  createTestFollowupRun,
  installAgentRunnerMemoryFixture,
  isModelRuntimeContextCarrier,
} from "./agent-runner.test-fixtures.js";
import { createReplyParams } from "./test-helpers.js";
import { createTypingController } from "./typing.js";

type ModelRequest = {
  messages: Array<{ role: string; content: unknown; tool_call_id?: string }>;
  tools?: Array<{ function?: { name?: string } }>;
};
// Keep injected prompt/tool growth out of this pending-input test. Reported usage
// still crosses preflight pressure once the approved input is added, while the
// rendered request fits without a second, unrelated overflow-recovery compaction.
const contextTokens = 65_536;
const priorInputTokens = 45_000;

const providerText = (content: unknown) =>
  extractTextFromChatContent(content, { joinWith: "\n", normalizeText: (text) => text }) ?? "";

function writeChunk(
  response: ServerResponse,
  delta: object,
  finish_reason: string | null = null,
  promptTokens?: number,
) {
  response.write(
    `data: ${JSON.stringify({
      id: "synthetic-completion",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [{ index: 0, delta, finish_reason }],
      usage:
        promptTokens === undefined
          ? undefined
          : {
              prompt_tokens: promptTokens,
              completion_tokens: 50,
              total_tokens: promptTokens + 50,
            },
    })}\n\n`,
  );
}

it.each([
  ["one archive", [[2_000, priorInputTokens]], 0],
  [
    "two archives",
    [
      [600, 10_000],
      [1_400, priorInputTokens],
    ],
    1,
  ],
] as const)(
  "required maintenance keeps admitted pending input current (%s)",
  (_history, priorTurns, expectedCompactions) =>
    withOpenClawTestState({ label: "required-maintenance-pending" }, async (state) => {
      const runtimeContext = "Synthetic current runtime fact for the approved request.";
      const approved =
        "Approved current request: preserve ünicode 🦞 and exact newlines.\n" +
        "Current background information.\n".repeat(1_600) +
        "Keep the current request active.";
      let observeForeground: (() => void) | undefined;
      const foregroundRequests: ModelRequest[] = [];
      const checkpointTools: string[][] = [];
      const checkpointText = "# Durable checkpoint\nArchive policy preserved.\n";
      const server = createServer((request, response) => {
        void readBody(request)
          .then((body) => {
            const received = JSON.parse(body) as ModelRequest;
            const tools = received.tools?.flatMap((tool) => tool.function?.name ?? []) ?? [];
            const lastUser = received.messages.findLast(
              (message) => message.role === "user" && !isModelRuntimeContextCarrier(message),
            );
            const lastUserText = providerText(lastUser?.content);
            const foreground = lastUserText.endsWith(approved);
            const activeInstructions = [
              lastUserText,
              ...received.messages
                .filter((message) => message.role === "system" || message.role === "developer")
                .map((message) => providerText(message.content)),
            ].join("\n");
            // Runtime-only tasks carry instructions in the system message. A
            // compactor can quote the same words but does not advertise write.
            const checkpoint =
              !foreground &&
              activeInstructions.includes("Checkpoint durable notes.") &&
              tools.includes("write");
            if (checkpoint) {
              checkpointTools.push(tools);
            }
            const writeCheckpoint = checkpoint && checkpointTools.length === 1;
            if (foreground) {
              foregroundRequests.push(received);
              observeForeground?.();
            }
            const text = foreground
              ? "FOREGROUND_READY"
              : checkpoint
                ? "NO_REPLY"
                : "## Decisions\nKeep documentation clear.\n## Open TODOs\nRespond to the current user.\n## Constraints/Rules\nPreserve approved input.\n## Pending user asks\nContinue the current task.\n## Exact identifiers\narchive-marker";
            response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
            writeChunk(
              response,
              writeCheckpoint
                ? {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: "checkpoint-write",
                        type: "function",
                        function: {
                          name: "write",
                          arguments: JSON.stringify({
                            path: "memory/checkpoint.md",
                            content: checkpointText,
                          }),
                        },
                      },
                    ],
                  }
                : { role: "assistant", content: text },
            );
            writeChunk(
              response,
              {},
              writeCheckpoint ? "tool_calls" : "stop",
              foreground ? 18_000 : 22_000,
            );
            response.end("data: [DONE]\n\n");
          })
          .catch((error: unknown) => {
            response.destroy(
              error instanceof Error ? error : new Error("Model fixture failed", { cause: error }),
            );
          });
      });
      const baseUrl = await listenLoopback(server);
      const sessionKey = "agent:main:main";
      const sessionId = "required-maintenance-session";
      const runId = "approved-foreground";
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const scope = { agentId: "main", sessionKey, sessionId, storePath };
      const cfg: OpenClawConfig = {
        agents: {
          entries: { main: { workspace: state.workspaceDir } },
          defaults: {
            workspace: state.workspaceDir,
            model: { primary: "test-provider/test-model" },
            // Retain the newest archive under the scaled provider-usage estimate.
            compaction: { keepRecentTokens: 32_000 },
          },
        },
        session: { store: storePath },
        tools: { profile: "coding", allow: ["read", "write"] },
        models: {
          providers: {
            "test-provider": {
              api: "openai-completions",
              apiKey: "synthetic-test-key",
              baseUrl: `${baseUrl}/v1`,
              models: [
                {
                  id: "test-model",
                  name: "Synthetic model",
                  reasoning: false,
                  input: ["text"],
                  contextWindow: contextTokens,
                  contextTokens,
                  maxTokens: 8_192,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      };
      const admissionOwner = prepareSystemAgentRunAdmission(
        cfg,
        `${runId}:ingress`,
        "main",
        "pending-regression",
      );
      let recorder: ReturnType<typeof createUserTurnTranscriptRecorder> | undefined;
      const scheduler = createTestGatewayScheduler();
      try {
        await setSessionMcpRuntimeScheduler(scheduler);
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg);
        const admittedRunContext = await admissionOwner.admit("embedded");
        const assertCurrent = resolveAdmittedRunActiveAssertion(admittedRunContext);
        if (!assertCurrent) {
          throw new Error("Missing real admitted run authority");
        }
        let entry: SessionEntry = {
          sessionId,
          updatedAt: Date.now(),
          totalTokens: priorInputTokens,
          totalTokensFresh: true,
          totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
        };
        await replaceSessionEntry(scope, entry);
        const seed = SessionManager.open(scope, state.workspaceDir);
        for (const [rows, inputTokens] of priorTurns) {
          seed.appendMessage({
            role: "user",
            content: "Earlier archive context.\n".repeat(rows),
            timestamp: 1,
          });
          seed.appendMessage(
            makeAssistantMessageFixture({
              provider: "test-provider",
              api: "openai-completions",
              model: "test-model",
              content: [{ type: "text", text: "ACK" }],
              stopReason: "stop",
              errorMessage: undefined,
              usage: {
                ...ZERO_USAGE_FIXTURE,
                input: inputTokens,
                output: 2,
                totalTokens: inputTokens + 2,
              },
            }),
          );
        }
        recorder = createUserTurnTranscriptRecorder({
          target: {
            ...scope,
            expectedSessionId: sessionId,
            sessionEntry: undefined,
            config: cfg,
          },
          input: { text: approved, timestamp: Date.now(), idempotencyKey: `${runId}:user` },
        });
        // Idle Control UI admission intentionally persists the approved user before ACK.
        expect(await recorder.stageApproved?.({ runId, assertCurrent })).toBe(true);
        await recorder.persistFallback();
        expect(recorder.hasPersisted()).toBe(true);
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
          timeoutMs: 30_000,
          senderIsOwner: true,
          suppressNextUserMessagePersistence: true,
          conversationToolPolicy: { deny: ["read"] },
        });
        followupRun.prompt = approved;
        followupRun.currentInboundContext = { text: runtimeContext };
        followupRun.userTurnTranscriptRecorder = recorder;
        entry = loadSessionEntry(scope)!;
        installAgentRunnerMemoryFixture(() => ({
          softThresholdTokens: 4_000,
          reserveTokensFloor: 8_192,
          forceFlushTranscriptBytes: 2 * 1024 * 1024,
          prompt: "Checkpoint durable notes. Reply NO_REPLY.",
          systemPrompt: "Write durable notes only.",
          relativePath: "memory/checkpoint.md",
        }));
        const foregroundContexts: unknown[][] = [];
        observeForeground = () => {
          foregroundContexts.push(
            SessionManager.open(scope, state.workspaceDir)
              .buildSessionContext()
              .messages.filter(
                (message) => message.role === "user" || message.role === "assistant",
              ),
          );
        };
        const result = await runReplyAgent(
          createReplyParams(followupRun, {
            transcriptCommandBody: followupRun.prompt,
            sessionKey: followupRun.run.sessionKey,
            opts: { runId },
            typing: createTypingController({}),
            sessionCtx: { Provider: "webchat", MessageSid: runId, SessionKey: sessionKey },
            sessionEntry: entry,
            sessionStore: { [sessionKey]: entry },
            storePath,
          }),
        );
        expect(checkpointTools).toHaveLength(2);
        expect(checkpointTools.flat()).not.toContain("read");
        expect(await readFile(path.join(state.workspaceDir, "memory/checkpoint.md"), "utf8")).toBe(
          checkpointText,
        );
        expect(loadSessionEntry(scope)?.memoryFlush?.kind).toBe("succeeded");
        expect(loadSessionEntry(scope)?.compactionCount ?? 0).toBe(expectedCompactions);
        const events = (await loadTranscriptEvents(scope)).map(asOptionalRecord);
        expect(events.filter((event) => event?.type === "compaction")).toHaveLength(
          expectedCompactions,
        );
        expect.soft(result).toMatchObject({ text: "FOREGROUND_READY" });
        expect(foregroundRequests).toHaveLength(1);
        const foregroundMessages = foregroundRequests[0]!.messages;
        const userIndex = foregroundMessages.findLastIndex(
          (message) => message.role === "user" && !isModelRuntimeContextCarrier(message),
        );
        const lastUser = foregroundMessages[userIndex];
        expect(providerText(lastUser?.content).endsWith(approved)).toBe(true);
        expect(providerText(lastUser?.content).split(approved)).toHaveLength(2);
        expect(foregroundMessages.filter(isModelRuntimeContextCarrier)).toHaveLength(1);
        expect(
          providerText(foregroundMessages.find(isModelRuntimeContextCarrier)?.content),
        ).toContain(runtimeContext);
        expect(foregroundMessages.findIndex(isModelRuntimeContextCarrier)).toBeGreaterThan(
          userIndex,
        );
        expect(foregroundContexts[0]!.slice(-3)).toMatchObject([
          {
            role: "user",
            content: "Earlier archive context.\n".repeat(priorTurns.at(-1)![0]),
          },
          { role: "assistant", content: [{ type: "text", text: "ACK" }] },
          { role: "user", content: approved, idempotencyKey: `${runId}:user` },
        ]);
      } finally {
        await waitForSessionMaintenance(sessionKey);
        recorder?.finishPendingInput?.("cancelled");
        await recorder?.waitForPendingInputSettlement?.();
        admissionOwner.close();
        const mcpManager = getSessionMcpRuntimeTestManager();
        for (const runtimeSessionId of mcpManager.listSessionIds()) {
          if (
            mcpManager.peekSession({ sessionId: runtimeSessionId })?.workspaceDir ===
            state.workspaceDir
          ) {
            await mcpManager.disposeSession(runtimeSessionId);
          }
        }
        await scheduler.stop();
        clearMemoryPluginState();
        clearRuntimeConfigSnapshot();
        await closeHttpServer(server);
      }
    }),
  60_000,
);
