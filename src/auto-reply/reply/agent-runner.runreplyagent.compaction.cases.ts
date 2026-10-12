import { createOpenAIResponsesTransportStreamFn } from "@openclaw/ai/transports";
import type { Model } from "@openclaw/llm-core";
import { describe, expect, it, type Mock } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../../../packages/ai/src/host.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
  oauthCred,
} from "../../agents/auth-profiles/credential-fixtures.test-support.js";
import { setRuntimeAuthProfileStoreSnapshot } from "../../agents/auth-profiles/runtime-snapshots.js";
import {
  clearRuntimeAuthProfileStoreSnapshot,
  getPreparedRuntimeAuthProfileStoreSnapshot,
} from "../../agents/auth-profiles/store.js";
import { normalizeMessagesForLlmBoundary } from "../../agents/embedded-agent-runner/run/attempt-llm-boundary.js";
import { submitEmbeddedAttemptPrompt } from "../../agents/embedded-agent-runner/run/attempt-prompt-submit.js";
import { createChatGPTV2CompactionBoundary } from "../../agents/embedded-agent-runner/run/chatgpt-v2-compaction.js";
import { createToolResultPromptProjectionState } from "../../agents/embedded-agent-runner/session-prompt-state.js";
import { prepareAgentRuntimeAuth } from "../../agents/runtime-plan/prepare-auth.js";
import {
  createAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
} from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import { agentSessionDeferThresholdCompaction } from "../../agents/sessions/agent-session-types.js";
import { withSessionManagerWrite } from "../../agents/sessions/session-manager-write-admission.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { SettingsManager } from "../../agents/sessions/settings-manager.js";
import type { SessionEntry } from "../../config/sessions.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.js";
import type { ReplyPayload } from "../types.js";
import type { FollowupRun } from "./queue.js";

type CompactionFixture = {
  createMinimalRun: (params?: {
    sessionEntry: SessionEntry;
    sessionStore: Record<string, SessionEntry>;
    storePath: string;
    runOverrides: Partial<FollowupRun["run"]>;
  }) => { run: () => Promise<ReplyPayload | ReplyPayload[] | undefined> };
  makeSessionFixture: (overrides: Partial<SessionEntry>) => Promise<{
    sessionEntry: SessionEntry;
    sessionStore: Record<string, SessionEntry>;
    storePath: string;
  }>;
  tempDirs: { make: (prefix: string) => string };
  state: {
    compactEmbeddedAgentSessionMock: Mock;
    runEmbeddedAgentMock: Mock;
  };
};

export function registerReplyCompactionCases({
  createMinimalRun,
  makeSessionFixture,
  tempDirs,
  state,
}: CompactionFixture): void {
  registerAgentSessionLoopTestLifecycle();
  describe("runReplyAgent compaction ownership", () => {
    it.each([
      {
        name: "explicit native OpenAI",
        provider: "openai",
        api: "openai-chatgpt-responses",
        configured: true,
        plannerFails: false,
      },
      {
        name: "default native OpenAI",
        provider: "openai",
        api: "openai-chatgpt-responses",
        configured: false,
        plannerFails: false,
      },
      {
        name: "default OpenAI with an unavailable selected profile",
        provider: "openai",
        api: "openai-chatgpt-responses",
        configured: false,
        plannerFails: true,
      },
      {
        name: "API-key OpenAI",
        provider: "openai",
        api: "openai-responses",
        configured: true,
        plannerFails: false,
      },
    ] as const)(
      "preserves $name compaction ownership before the first attempt",
      async ({ provider, api, configured, plannerFails }) => {
        const native = api === "openai-chatgpt-responses" && !plannerFails;
        const agentDir = tempDirs.make("openclaw-reply-compaction-auth-");
        const model = {
          id: "gpt-5.5",
          name: "Compaction ownership fixture",
          provider,
          api,
          baseUrl:
            api === "openai-chatgpt-responses"
              ? "https://chatgpt.com/backend-api/codex"
              : "https://api.openai.com/v1",
          reasoning: false,
          input: ["text"],
          contextWindow: 200_000,
          maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        } satisfies Model;
        const config = {
          agents: {
            defaults: {
              compaction: { memoryFlush: { enabled: false } },
            },
          },
          ...(configured
            ? {
                models: {
                  providers: {
                    [provider]: {
                      api,
                      ...(api === "openai-responses" ? { auth: "api-key" as const } : {}),
                      baseUrl: model.baseUrl,
                      models: [{ ...model, contextTokens: 200_000 }],
                    },
                  },
                },
              }
            : {}),
        } satisfies OpenClawConfig;
        const { sessionEntry, sessionStore, storePath } = await makeSessionFixture({
          totalTokens: 190_000,
          totalTokensFresh: true,
          totalTokensVersion: 1,
          agentRuntimeOverride: "openclaw",
          ...(plannerFails
            ? { authProfileOverride: "openai:missing", authProfileOverrideSource: "user" as const }
            : {}),
        });
        const sessionManager = SessionManager.open(
          { agentId: "main", sessionId: sessionEntry.sessionId, sessionKey: "main", storePath },
          tempDirs.make("openclaw-reply-compaction-"),
        );
        await sessionManager.appendMessageAsync({
          role: "user",
          content: "Remember copper.",
          timestamp: 1,
        });
        await sessionManager.appendMessageAsync(
          createAssistant(model, [{ type: "text", text: "Copper recorded." }], "stop", 190_000),
        );
        await replaceSessionEntry({ storePath, sessionKey: "main" }, sessionEntry);
        const order: string[] = [];
        const requests: Array<{ input: Array<Record<string, unknown>> }> = [];
        let attemptError: unknown;
        state.compactEmbeddedAgentSessionMock.mockImplementation(async () => {
          order.push("client-compaction");
          return { ok: true, compacted: false, reason: "already under target" };
        });
        const initialHost = getAiTransportHost();
        configureAiTransportHost({
          buildModelFetch: () => async (_input, init) => {
            // SAFETY: The fixture's Responses transport serializes an input array in every request.
            const body = (await new Response(init?.body).json()) as (typeof requests)[number];
            requests.push(body);
            const events: unknown[] = [];
            if (body.input.at(-1)?.type === "compaction_trigger") {
              events.push({
                type: "response.output_item.done",
                output_index: 0,
                item: { type: "compaction", encrypted_content: "fixture-checkpoint" },
              });
            } else {
              const item = {
                type: "message",
                id: "msg_fixture",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "done", annotations: [] }],
              };
              events.push(
                { type: "response.output_item.added", output_index: 0, item },
                { type: "response.output_item.done", output_index: 0, item },
              );
            }
            events.push({
              type: "response.completed",
              response: {
                id: "resp_fixture",
                status: "completed",
                output: [],
                usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35 },
              },
            });
            return new Response(
              events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        });
        const runAttempt = async () => {
          order.push("attempt");
          if (native) {
            const { session } = await createTestSession({
              model,
              sessionManager,
              systemPrompt: "Stable fixture instructions.",
              settingsManager: SettingsManager.inMemory({
                compaction: { enabled: true, reserveTokens: 20_000 },
                retry: { enabled: false },
              }),
              contextOverflowRecoveryOwner: "caller",
            });
            session.agent.transformContext = async (messages) =>
              normalizeMessagesForLlmBoundary(messages, {
                appendOnlyRuntimeContext: true,
                inHistorySystemUpdates: true,
              });
            session[agentSessionDeferThresholdCompaction] = true;
            const transport = createOpenAIResponsesTransportStreamFn();
            session.agent.streamFn = (activeModel, context, options) =>
              transport(activeModel, context, { ...options, apiKey: "fixture-api-key" });
            const withTranscriptWrite = <T>(write: () => Promise<T>) =>
              withSessionManagerWrite(sessionManager, write);
            await submitEmbeddedAttemptPrompt({
              attempt: { sessionId: session.sessionId },
              activeSession: session,
              contextTokenBudget: 200_000,
              compactBeforeRequest: createChatGPTV2CompactionBoundary({
                session,
                contextTokenBudget: 200_000,
                reserveTokens: 20_000,
                timeoutMs: 30_000,
                assertActive: () => {},
                withTranscriptWrite,
                onFallback: () => order.push("native-fallback"),
              }),
              images: [],
              modelPrompt: "Current request.",
              transcriptPrompt: "Current request.",
              onFinalPromptText: () => {},
              onSteeringAcknowledged: () => {},
              persistToolResultProjections: async () => {},
              withTranscriptWrite,
              runtimeOnly: false,
              systemPrompt: "Stable fixture instructions.",
              toolResultAggregateMaxChars: 80_000,
              toolResultMaxChars: 80_000,
              toolResultPromptProjectionState: createToolResultPromptProjectionState(),
              trajectoryRecorder: null,
              transcriptLeafId: sessionManager.getLeafId(),
              appendOnlyRuntimeContext: true,
              promptActiveSession: (text, options) => session.prompt(text, options),
            });
          }
          return { payloads: [{ text: "done" }], meta: {} };
        };
        state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
          try {
            return await runAttempt();
          } catch (error) {
            attemptError = error;
            throw error;
          }
        });
        const { run } = createMinimalRun({
          sessionEntry,
          sessionStore,
          storePath,
          runOverrides: {
            agentDir,
            authProfileId: plannerFails ? "openai:missing" : undefined,
            authProfileIdSource: plannerFails ? "user" : undefined,
            provider,
            model: model.id,
            config,
            thinkingCatalog: [
              configured
                ? { ...model, contextTokens: 200_000 }
                : {
                    id: model.id,
                    provider,
                    input: ["text"],
                    reasoning: false,
                    contextWindow: 200_000,
                    contextTokens: 200_000,
                  },
            ],
          },
        });
        setRuntimeAuthProfileStoreSnapshot(
          createAuthProfileStoreFixture({
            [`${provider}:fixture`]:
              api === "openai-chatgpt-responses"
                ? oauthCred({
                    provider,
                    access: "fixture-access",
                    refresh: "fixture-refresh",
                    expires: Date.now() + 600_000,
                  })
                : createApiKeyCredential(provider, "fixture-api-key"),
          }),
          agentDir,
        );
        try {
          const prepareAuth = () =>
            prepareAgentRuntimeAuth({
              provider,
              modelId: model.id,
              config,
              agentDir,
              authProfileStore: getPreparedRuntimeAuthProfileStoreSnapshot(agentDir),
              sessionAuthProfileId: plannerFails ? "openai:missing" : undefined,
              sessionAuthProfileSource: plannerFails ? "user" : undefined,
              harnessId: "openclaw",
            });
          if (plannerFails) {
            expect(prepareAuth).toThrow();
          } else {
            expect(prepareAuth().plan.modelRoute).toMatchObject({
              api,
              baseUrl: model.baseUrl,
            });
          }
          const result = await run();
          expect(order).toEqual(native ? ["attempt"] : ["client-compaction", "attempt"]);
          // Surface the embedded attempt's own failure before asserting its output.
          expect(attemptError).toBeUndefined();
          expect(result).toMatchObject({ text: "done" });
          if (native) {
            expect(state.compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
            expect(requests.map((request) => request.input.at(-1)?.type)).toEqual([
              "compaction_trigger",
              "compaction",
            ]);
          } else {
            expect(state.compactEmbeddedAgentSessionMock).toHaveBeenCalledOnce();
            expect(requests).toHaveLength(0);
          }
        } finally {
          configureAiTransportHost(initialHost);
          clearRuntimeAuthProfileStoreSnapshot(agentDir);
        }
      },
    );
    it("surfaces overflow fallback when embedded run returns empty payloads", async () => {
      state.runEmbeddedAgentMock.mockImplementationOnce(async () => ({
        payloads: [],
        meta: {
          durationMs: 1,
          error: {
            kind: "context_overflow",
            message: 'Context overflow: Summarization failed: 400 {"message":"prompt is too long"}',
          },
        },
      }));

      const { run } = createMinimalRun();
      const res = await run();
      const payload = Array.isArray(res) ? res[0] : res;
      if (!payload) {
        throw new Error("expected payload");
      }
      expect(payload.text).toContain("Auto-compaction could not recover this turn");
      expect(payload.text).toContain("fresh session or using a model with a larger context window");
      expect(payload.text).toContain("/new");
    });

    it("surfaces overflow fallback when embedded payload text is whitespace-only", async () => {
      state.runEmbeddedAgentMock.mockImplementationOnce(async () => ({
        payloads: [{ text: "   \n\t  ", isError: true }],
        meta: {
          durationMs: 1,
          error: {
            kind: "context_overflow",
            message: 'Context overflow: Summarization failed: 400 {"message":"prompt is too long"}',
          },
        },
      }));

      const { run } = createMinimalRun();
      const res = await run();
      const payload = Array.isArray(res) ? res[0] : res;
      if (!payload) {
        throw new Error("expected payload");
      }
      expect(payload.text).toContain("Auto-compaction could not recover this turn");
      expect(payload.text).toContain("fresh session or using a model with a larger context window");
      expect(payload.text).toContain("/new");
    });
  });
}
