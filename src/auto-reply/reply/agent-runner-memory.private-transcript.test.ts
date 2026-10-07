import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { text as readBody } from "node:stream/consumers";
import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  getSessionMcpRuntimeManagerForTesting,
  peekSessionMcpRuntime,
  setSessionMcpRuntimeScheduler,
} from "../../agents/agent-bundle-mcp-manager-api.js";
import { waitForSessionMaintenance } from "../../agents/session-maintenance/coordinator.js";
import { createSessionMaintenanceFollowup } from "../../agents/session-maintenance/run.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../../agents/test-helpers/assistant-message-fixtures.js";
import { ZERO_USAGE_FIXTURE } from "../../agents/test-helpers/usage-fixtures.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../../config/sessions.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildTimestampPrefix,
  timestampOptsFromConfig,
} from "../../gateway/server-methods/agent-timestamp.js";
import { createAbortError } from "../../infra/abort-signal.js";
import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import { clearMemoryPluginState } from "../../plugins/memory-state.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runMemoryFlushIfNeeded } from "./agent-runner-memory.js";
import { runReplyAgent } from "./agent-runner.js";
import {
  createTestFollowupRun,
  installAgentRunnerMemoryFixture,
  isModelRuntimeContextCarrier,
} from "./agent-runner.test-fixtures.js";
import { createTypingController } from "./typing.js";

type ModelRequest = { messages: Array<{ role: string; content: unknown }> };
const text = (content: unknown) =>
  extractTextFromChatContent(content, { joinWith: "\n", normalizeText: (value) => value }) ?? "";
const isHumanMessage = (message: ModelRequest["messages"][number]) =>
  message.role === "user" && !isModelRuntimeContextCarrier(message);
const lastHumanText = (request: ModelRequest) =>
  text(request.messages.findLast(isHumanMessage)?.content);

function model(id: string, name: string, contextTokens: number): ModelDefinitionConfig {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    contextWindow: contextTokens,
    contextTokens,
    maxTokens: 8_192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function finishModelResponse(response: ServerResponse, content: string): void {
  for (const chunk of [
    { choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] },
    {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 21_000, completion_tokens: 2, total_tokens: 21_002 },
    },
  ]) {
    response.write(
      `data: ${JSON.stringify({
        id: "private-memory-fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        ...chunk,
      })}\n\n`,
    );
  }
  response.end("data: [DONE]\n\n");
}

function expectRetiredRuntimes(sessionIds: Iterable<string>, message: string): void {
  for (const sessionId of sessionIds) {
    expect.soft(peekSessionMcpRuntime({ sessionId }), message).toBeUndefined();
  }
}

it.each(["completed", "interrupted"] as const)(
  "keeps %s optional memory inference out of the next human turn",
  async (outcome) => {
    await withOpenClawTestState({ label: "private-memory-run" }, async (state) => {
      const entered = createDeferred();
      const interrupted = new AbortController();
      const human = "Reply only FOREGROUND_READY. Preserve ünicode 🦞.\nThis is the human request.";
      const runtimeContext = "Synthetic current runtime fact for the next human turn.";
      const requests: ModelRequest[] = [];
      const requestErrors: unknown[] = [];
      const runtimeBudgets: number[] = [];
      const privateSessionIds = new Set<string>();
      let missingPrivateSessionId = false;
      let completeFirstPrivateResponse: (() => void) | undefined;
      const stopDiagnostics = onInternalDiagnosticEvent((event) => {
        if (
          event.type === "model.call.started" &&
          event.model === "test-model" &&
          event.contextTokenBudget !== undefined
        ) {
          runtimeBudgets.push(event.contextTokenBudget);
          if (event.sessionId) {
            privateSessionIds.add(event.sessionId);
          } else {
            missingPrivateSessionId = true;
          }
        }
      });
      const server = createServer((request, response) => {
        if (request.url === "/mcp" && request.method !== "POST") {
          response.writeHead(request.method === "DELETE" ? 200 : 405).end();
          return;
        }
        void readBody(request)
          .then((body) => {
            // Memory preparation reads the MCP catalog before inference. Keep a real
            // server owned by the run without adding tools to its model request.
            if (request.url === "/mcp") {
              const message = JSON.parse(body) as {
                id?: number;
                method: string;
                params?: { protocolVersion?: string };
              };
              let result;
              if (message.method === "initialize") {
                result = {
                  protocolVersion: message.params?.protocolVersion,
                  capabilities: { tools: {} },
                  serverInfo: { name: "memory-lifetime", version: "1" },
                };
              } else if (message.method === "tools/list") {
                result = { tools: [] };
              }
              if (!result) {
                response.writeHead(202).end();
                return;
              }
              response.writeHead(200, { "content-type": "application/json" });
              response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
              return;
            }
            const modelRequest = JSON.parse(body) as ModelRequest;
            requests.push(modelRequest);
            const isHuman = lastHumanText(modelRequest).endsWith(human);
            response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
            response.flushHeaders();
            const completeResponse = () =>
              finishModelResponse(response, isHuman ? "FOREGROUND_READY" : "NO_REPLY");
            if (!isHuman) {
              if (requests.length === 1 && outcome === "completed") {
                completeFirstPrivateResponse = completeResponse;
              }
              entered.resolve();
              if (requests.length === 1) {
                return;
              }
            }
            completeResponse();
          })
          .catch((error: unknown) => {
            requestErrors.push(error);
            entered.reject(error);
            response.destroy();
          });
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing fixture address");
      }
      const scope = {
        agentId: "main",
        sessionId: "private-memory-source",
        sessionKey: "agent:main:main",
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      const cfg: OpenClawConfig = {
        agents: {
          entries: { main: { workspace: state.workspaceDir } },
          defaults: {
            workspace: state.workspaceDir,
            model: { primary: "test-provider/owner-model" },
          },
        },
        session: { store: scope.storePath },
        tools: { profile: "coding" },
        mcp: {
          servers: {
            fixture: { transport: "streamable-http", url: `http://127.0.0.1:${address.port}/mcp` },
          },
        },
        models: {
          providers: {
            "test-provider": {
              api: "openai-completions",
              apiKey: "synthetic-fixture-key",
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              models: [
                model("owner-model", "Owner fixture", 128_000),
                model("test-model", "Fixture", 1_000_000),
              ],
            },
          },
        },
      };
      let flush: ReturnType<typeof runMemoryFlushIfNeeded> | undefined;
      let admission: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
      const scheduler = createTestGatewayScheduler();
      try {
        await setSessionMcpRuntimeScheduler(scheduler);
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg);
        await replaceSessionEntry(scope, {
          sessionId: scope.sessionId,
          updatedAt: Date.now(),
          totalTokens: 120_000,
          totalTokensFresh: true,
          totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
        });
        const transcript = SessionManager.open(scope, state.workspaceDir);
        transcript.appendMessage(makeUserMessage("Remember the Cedar project receipt.", 1));
        transcript.appendMessage(
          makeAssistantMessageFixture({
            provider: "test-provider",
            model: "owner-model",
            api: "openai-completions",
            content: [{ type: "text", text: "Cedar receipt saved." }],
            stopReason: "stop",
            errorMessage: undefined,
            usage: {
              ...ZERO_USAGE_FIXTURE,
              input: 120_000,
              output: 2,
              totalTokens: 120_002,
            },
          }),
        );
        const original = await loadTranscriptEvents(scope);
        const entry = loadSessionEntry(scope)!;
        const foreground = createTestFollowupRun({
          ...scope,
          sessionFile: scope.sessionKey,
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          config: cfg,
          provider: "test-provider",
          model: "owner-model",
          messageProvider: "webchat",
          thinkLevel: "off",
          timeoutMs: 30_000,
          senderIsOwner: true,
        });
        const maintenance = createSessionMaintenanceFollowup({
          run: foreground.run,
          sessionEntry: entry,
          cfg,
          sessionKey: scope.sessionKey,
          provider: "test-provider",
          model: "owner-model",
          auth: {},
        });
        installAgentRunnerMemoryFixture(() => ({
          softThresholdTokens: 4_000,
          reserveTokensFloor: 8_192,
          forceFlushTranscriptBytes: 2 * 1024 * 1024,
          prompt: "Checkpoint durable notes. Reply NO_REPLY.",
          systemPrompt: "Write durable notes only.",
          relativePath: "memory/checkpoint.md",
          model: "test-provider/test-model",
        }));
        admission = await beginSessionWorkAdmission({
          scope: scope.storePath,
          identities: [scope.sessionKey, scope.sessionId],
          signal: interrupted.signal,
          assertAllowed: () => {
            interrupted.signal.throwIfAborted();
            expect(loadSessionEntry(scope)?.sessionId).toBe(scope.sessionId);
          },
        });
        flush = admission.run(() =>
          runMemoryFlushIfNeeded({
            cfg,
            followupRun: maintenance,
            promptForEstimate: "",
            defaultModel: "owner-model",
            resolvedVerboseLevel: "off",
            sessionEntry: entry,
            sessionStore: { [scope.sessionKey]: entry },
            sessionKey: scope.sessionKey,
            storePath: scope.storePath,
            abortSignal: interrupted.signal,
          }),
        );
        await Promise.race([
          entered.promise,
          flush.then(() => {
            throw new Error("Memory run ended before reaching inference");
          }),
        ]);
        await waitForDiagnosticEventsDrained();
        expect(missingPrivateSessionId).toBe(false);
        const firstPrivateSessionIds = [...privateSessionIds];
        expect(firstPrivateSessionIds.length).toBeGreaterThan(0);
        for (const sessionId of firstPrivateSessionIds) {
          expect(peekSessionMcpRuntime({ sessionId }) !== undefined).toBe(true);
        }
        if (outcome === "interrupted") {
          interrupted.abort(new Error("next human turn"));
        } else {
          if (!completeFirstPrivateResponse) {
            throw new Error("Private response was not held before completion");
          }
          completeFirstPrivateResponse();
          completeFirstPrivateResponse = undefined;
        }
        expect((await flush).outcome).toBe(outcome === "interrupted" ? "failed" : "completed");
        admission.release();
        admission = undefined;
        expect(requests).toHaveLength(1);
        expect(runtimeBudgets).toEqual([128_000]);
        expectRetiredRuntimes(
          firstPrivateSessionIds,
          "completed private memory run must retire its acquired MCP runtime",
        );
        expect.soft(await loadTranscriptEvents(scope)).toEqual(original);
        if (outcome === "interrupted") {
          expect.soft(loadSessionEntry(scope)?.memoryFlush).toBeUndefined();
        }
        foreground.prompt = human;
        foreground.currentInboundContext = { text: runtimeContext };
        const current = loadSessionEntry(scope)!;
        const result = await runReplyAgent({
          commandBody: human,
          transcriptCommandBody: human,
          followupRun: foreground,
          queueKey: scope.sessionKey,
          resolvedQueue: { mode: "interrupt" },
          shouldSteer: false,
          shouldFollowup: false,
          isActive: false,
          opts: { runId: "next-human" },
          typing: createTypingController({}),
          sessionCtx: {
            Provider: "webchat",
            MessageSid: "next-human",
            SessionKey: scope.sessionKey,
          },
          sessionEntry: current,
          sessionStore: { [scope.sessionKey]: current },
          sessionKey: scope.sessionKey,
          storePath: scope.storePath,
          defaultModel: "owner-model",
          resolvedVerboseLevel: "off",
          isNewSession: false,
          blockStreamingEnabled: false,
          resolvedBlockStreamingBreak: "message_end",
          shouldInjectGroupIntro: false,
          typingMode: "never",
        });
        expect(result).toMatchObject({ text: "FOREGROUND_READY" });
        const humanRequests = requests.filter((request) => lastHumanText(request).endsWith(human));
        expect(humanRequests).toHaveLength(1);
        const humanMessages = humanRequests[0]!.messages;
        const userIndex = humanMessages.findLastIndex(isHumanMessage);
        const nextUser = text(humanMessages[userIndex]?.content);
        expect(humanMessages.filter(isModelRuntimeContextCarrier)).toHaveLength(1);
        expect(text(humanMessages.find(isModelRuntimeContextCarrier)?.content)).toContain(
          runtimeContext,
        );
        expect(humanMessages.findIndex(isModelRuntimeContextCarrier)).toBeGreaterThan(userIndex);
        const canonicalHuman = SessionManager.open(scope)
          .buildSessionContext()
          .messages.findLast(
            (message) => message.role === "user" && text(message.content) === human,
          );
        if (!canonicalHuman || typeof canonicalHuman.timestamp !== "number") {
          throw new Error("Missing canonical human timestamp");
        }
        const prefix = buildTimestampPrefix(
          new Date(canonicalHuman.timestamp),
          timestampOptsFromConfig(cfg),
        );
        expect(prefix).toBeDefined();
        expect(nextUser).toBe(`${prefix}${human}`);
        await waitForDiagnosticEventsDrained();
        expect.soft(missingPrivateSessionId).toBe(false);
        expectRetiredRuntimes(
          [...privateSessionIds].filter((sessionId) => !firstPrivateSessionIds.includes(sessionId)),
          "later private memory run must retire before the human turn returns",
        );
      } finally {
        completeFirstPrivateResponse?.();
        interrupted.abort(createAbortError("fixture cleanup"));
        await flush?.catch(() => undefined);
        admission?.release();
        await waitForSessionMaintenance(scope.sessionKey);
        // Retire fixture-owned leftovers after work settles, including failed setup or assertions.
        const mcpManager = getSessionMcpRuntimeManagerForTesting();
        for (const sessionId of mcpManager.listSessionIds()) {
          if (mcpManager.peekSession({ sessionId })?.workspaceDir === state.workspaceDir) {
            await mcpManager.disposeSession(sessionId);
          }
        }
        await scheduler.stop();
        clearMemoryPluginState();
        clearRuntimeConfigSnapshot();
        stopDiagnostics();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        expect(requestErrors).toEqual([]);
      }
    });
  },
  60_000,
);
