import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bindSessionMcpRuntimeTestScheduler } from "../../agents/agent-bundle-mcp-manager.test-support.js";
import { createApiKeyCredential } from "../../agents/auth-profiles/credential-fixtures.test-support.js";
import { persistAuthProfileBatch } from "../../agents/auth-profiles/upsert-with-lock.js";
import { providerResponse } from "../../agents/embedded-agent-runner.wire.test-support.js";
import { createEmbeddedAgentRunnerOpenAiConfig } from "../../agents/test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { writeTempPlugin } from "../../agents/test-helpers/temp-plugin-extension-fixtures.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { loadExactSessionEntry } from "../../config/sessions/session-accessor.js";
import type { AgentModelEntryConfig } from "../../config/types.agent-defaults.js";
import * as backoff from "../../infra/backoff.js";
import { loadAndActivateRootPluginRegistry } from "../../plugins/loader.js";
import { clearActivePluginRegistry } from "../../plugins/runtime.js";
import { readModelPromptProjection } from "../../sessions/user-turn-transcript.message.js";
import { readTranscriptMessages } from "../../sessions/user-turn-transcript.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { getReplyFromConfig } from "./get-reply.js";

beforeEach(async () => {
  await bindSessionMcpRuntimeTestScheduler();
  vi.spyOn(backoff, "sleepWithAbort").mockImplementation(async (_delay, signal) => {
    signal?.throwIfAborted();
  });
});

afterEach(() => vi.restoreAllMocks());

it.each(["openai-responses", "openai-completions"] as const)(
  "preserves the admitted user and new plugin context on %s fallback",
  { timeout: 120_000 },
  (primaryApi) =>
    withOpenClawTestState({ label: "reply-fallback-transcript" }, async (state) => {
      await mkdir(state.agentDir(), { recursive: true });
      await writeFile(
        path.join(state.agentDir(), "settings.json"),
        JSON.stringify({ retry: { provider: { maxRetries: 2 } } }),
      );
      const config = createEmbeddedAgentRunnerOpenAiConfig(["primary", "backup"]);
      const models = expectDefined(config.models, "model fixture");
      const base = expectDefined(models.providers?.openai, "provider fixture");
      // Exercise provider fallback with room for the full prompt, not context recovery.
      base.models = base.models.map((model) => ({ ...model, contextWindow: 128_000 }));
      const endpoint = {
        baseUrl: "http://127.0.0.1:44080/v1",
        request: { allowPrivateNetwork: true },
      };
      models.providers = {
        "mock-openai": {
          ...base,
          ...endpoint,
          api: primaryApi,
          apiKey: undefined,
          models: base.models.map((model) => ({ ...model, api: primaryApi })),
        },
        "mock-backup": { ...base, ...endpoint, apiKey: "synthetic-fallback-key" },
      };
      models.catalogRefresh = { enabled: false };
      config.auth = {
        profiles: { "mock-openai:fixture": { provider: "mock-openai", mode: "api_key" } },
        order: { "mock-openai": ["mock-openai:fixture"] },
      };
      const modelConfig = (): AgentModelEntryConfig => ({
        agentRuntime: { id: "openclaw" },
        params: { transport: "sse", openaiWsWarmup: false },
      });
      config.agents = {
        entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
        defaults: {
          workspace: state.workspaceDir,
          skipBootstrap: true,
          model: { primary: "mock-openai/primary", fallbacks: ["mock-backup/backup"] },
          models: { "mock-openai/primary": modelConfig(), "mock-backup/backup": modelConfig() },
        },
      };
      const pluginDir = state.path("plugins", "fallback-context");
      writeTempPlugin({
        dir: state.path("plugins"),
        id: "fallback-context",
        filename: "index.cjs",
        manifest: { activation: { onStartup: true } },
        body: `module.exports = { id: "fallback-context", register(api) {
        api.on("before_prompt_build", (_event, ctx) => ({
          prependContext: ctx.modelProviderId === "mock-backup" ? "Backup context." : "Primary context."
        }));
      }};`,
      });
      config.plugins = {
        allow: ["fallback-context"],
        load: { paths: [pluginDir] },
        slots: { memory: "none" },
        entries: {
          "fallback-context": { enabled: true, hooks: { allowConversationAccess: true } },
        },
      };
      withFullRuntimeReplyConfig(config);
      await state.writeConfig(config);
      setRuntimeConfigSnapshot(config);
      await persistAuthProfileBatch({
        stateDir: state.stateDir,
        profiles: [
          {
            profileId: "mock-openai:fixture",
            credential: createApiKeyCredential("mock-openai", "synthetic-fallback-key"),
          },
        ],
      });
      try {
        await loadAndActivateRootPluginRegistry({
          config,
          workspaceDir: state.workspaceDir,
          throwOnLoadError: true,
        });
        const requests: Array<{ model: string; input?: unknown }> = [];
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
          const request = new Request(url, options);
          expect(request.headers.get("authorization")).toBe("Bearer synthetic-fallback-key");
          const body = (await request.json()) as { model: string; input?: unknown };
          requests.push(body);
          if (body.model === "primary") {
            return new Response(
              JSON.stringify({
                error: {
                  message: "Synthetic rate limit exceeded",
                  type: "rate_limit_error",
                },
              }),
              { status: 429, headers: { "content-type": "application/json" } },
            );
          }
          return providerResponse({
            api: "openai-responses",
            model: body.model,
            id: "fallback-response",
            messageId: "fallback-message",
            text: "Fallback report",
            calls: [],
          }).response;
        });
        const message = "Reply exactly Fallback report";
        const sessionKey = "agent:main:dashboard:fallback-proof";
        const result = await getReplyFromConfig(
          {
            Body: message,
            BodyForAgent: message,
            SessionKey: sessionKey,
            From: "webchat",
            To: "webchat",
            Provider: "webchat",
            Surface: "webchat",
            ChatType: "direct",
            MessageSid: "rate-limit-user",
            CommandAuthorized: true,
          },
          {},
          config,
        );
        expect([result].flat()).toEqual(
          expect.arrayContaining([expect.objectContaining({ text: "Fallback report" })]),
        );
        expect(requests.map((request) => request.model)).toEqual([
          "primary",
          "primary",
          "primary",
          "backup",
        ]);
        const backupInput = JSON.stringify(requests.at(-1)?.input);
        expect(backupInput).toContain(message);
        expect(backupInput).toContain("Primary context.");
        expect(backupInput).toContain("Backup context.");
        const storePath = path.join(state.agentDir(), "openclaw-agent.sqlite");
        const session = expectDefined(
          loadExactSessionEntry({ agentId: "main", storePath, sessionKey }),
          "reply session",
        );
        const transcript = await readTranscriptMessages({
          storePath,
          sessionKey,
          sessionId: session.entry.sessionId,
        });
        const users = transcript.filter(
          (entry) => entry.role === "user" && entry.display !== false,
        );
        expect(users).toHaveLength(1);
        expect(users[0]).toMatchObject({ content: message, idempotencyKey: expect.any(String) });
        const projection = readModelPromptProjection(users[0]);
        expect(projection).toContain("Primary context.");
        expect(projection).not.toContain("Backup context.");
      } finally {
        await clearActivePluginRegistry();
      }
    }),
);
