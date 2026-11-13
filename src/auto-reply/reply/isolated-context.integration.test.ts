import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { text as readBody } from "node:stream/consumers";
import { expect, it } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../../test/helpers/gateway-integration-fixtures.js";
import { modelDefinition } from "../../agents/model-auth.fixtures.test-support.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../../agents/prepared-model-runtime.test-support.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../../agents/test-helpers/assistant-message-fixtures.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearInternalHooks, registerInternalHook } from "../../hooks/internal-hooks.js";
import { loadAndActivateRootPluginRegistry } from "../../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  writePlugin,
} from "../../plugins/loader.test-fixtures.js";
import { clearActivePluginRegistry } from "../../plugins/runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { getReplyFromConfig } from "./get-reply.js";

type ModelRequest = {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  tools?: unknown[];
};

it("keeps installed private context and tools out of an isolated public model request", async () => {
  await withOpenClawTestState(
    { label: "isolated-public-reply", agentEnv: "clear" },
    async (state) => {
      const requests: ModelRequest[] = [];
      const adoptedAtModelIo: boolean[] = [];
      let adopted = false;
      let overflow = false;
      const server = createServer((request, response) => {
        void readBody(request)
          .then((body) => {
            requests.push(JSON.parse(body) as ModelRequest);
            adoptedAtModelIo.push(adopted);
            if (overflow) {
              response.writeHead(400, { "content-type": "application/json" });
              response.end(
                JSON.stringify({
                  error: {
                    type: "invalid_request_error",
                    code: "context_length_exceeded",
                    message: "Request size exceeds context window",
                  },
                }),
              );
              return;
            }
            response.writeHead(200, { "content-type": "text/event-stream" });
            for (const choice of [
              { delta: { role: "assistant", content: "PUBLIC_REPLY" }, finish_reason: null },
              { delta: {}, finish_reason: "stop" },
            ]) {
              response.write(
                "data: " +
                  JSON.stringify({
                    id: "synthetic",
                    object: "chat.completion.chunk",
                    created: 1,
                    model: "public-model",
                    choices: [{ index: 0, ...choice }],
                  }) +
                  "\n\n",
              );
            }
            response.end("data: [DONE]\n\n");
          })
          .catch(() => response.destroy());
      });
      const baseUrl = await listenLoopback(server);
      const plugin = writePlugin({
        id: "private-context-canary",
        body: `module.exports = { id: "private-context-canary", register(api) {
        api.on("before_prompt_build", () => ({ prependContext: "PRIVATE_PROMPT_MEMORY_CANARY" }));
        api.on("agent_turn_prepare", () => ({ prependContext: "PRIVATE_TURN_PREPARE_CANARY" }));
        api.registerMemoryCapability({ promptBuilder: () => ["PRIVATE_MEMORY_PROVIDER_CANARY"] });
        api.registerAgentHarness({ id: "unsafe-native", label: "Unqualified fixture runtime", supports: () => ({ supported: true }), runAttempt: async () => { throw new Error("UNSAFE_RUNTIME_WAS_CALLED"); } });
        api.registerContextEngine("private-context-canary", () => ({
          info: { id: "private-context-canary", name: "Synthetic private engine", transcriptSemantics: { currentTurnFence: "before-current-turn-entry-v1", turnAdvancementIdempotency: "atomic-idempotent-v1" } },
          ingest: async () => ({ ingested: false }),
          assemble: async ({ messages }) => ({ messages, estimatedTokens: 0, systemPromptAddition: "PRIVATE_ENGINE_CANARY" }),
          compact: async () => ({ ok: true, compacted: false }),
          // This fixture owns no mutable history; committing its empty state is idempotent.
          commitTurn: async () => ({ status: "committed" })
        }));
      }};`,
      });
      await fs.writeFile(
        path.join(plugin.dir, "openclaw.plugin.json"),
        JSON.stringify({
          id: plugin.id,
          kind: "memory",
          configSchema: { type: "object", properties: {}, additionalProperties: false },
        }),
      );
      const cfg: OpenClawConfig = {
        agents: {
          entries: {
            public: { agentDir: state.agentDir("public"), workspace: state.workspaceDir },
          },
          defaults: { workspace: state.workspaceDir, model: { primary: "fixture/public-model" } },
        },
        session: { store: path.join(state.sessionsDir("public"), "sessions.json") },
        models: {
          providers: {
            fixture: {
              api: "openai-completions",
              apiKey: "synthetic-only",
              baseUrl: baseUrl + "/v1",
              agentRuntime: { id: "openclaw" },
              models: [
                modelDefinition("public-model", { reasoning: false, contextWindow: 128_000 }),
              ],
            },
          },
        },
        plugins: {
          allow: [plugin.id],
          load: { paths: [plugin.file] },
          slots: { memory: plugin.id, contextEngine: plugin.id },
          entries: {
            [plugin.id]: {
              enabled: true,
              hooks: { allowConversationAccess: true, allowPromptModification: true },
            },
          },
        },
        skills: { load: { watch: false } },
      };
      try {
        await fs.writeFile(path.join(state.workspaceDir, "USER.md"), "PRIVATE_USER_CANARY");
        await fs.writeFile(
          path.join(state.workspaceDir, "MEMORY.md"),
          "PRIVATE_WORKSPACE_MEMORY_CANARY",
        );
        registerInternalHook("agent:bootstrap", (event) => {
          if (
            event.type === "agent" &&
            event.action === "bootstrap" &&
            "bootstrapFiles" in event.context
          ) {
            const files = event.context.bootstrapFiles;
            if (Array.isArray(files)) {
              files.push({
                name: "USER.md",
                path: path.join(state.workspaceDir, "hook.md"),
                content: "PRIVATE_BOOTSTRAP_HOOK_CANARY",
                missing: false,
              });
            }
          }
        });
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg);
        await loadAndActivateRootPluginRegistry({
          config: cfg,
          cache: false,
          onlyPluginIds: [plugin.id],
        });
        for (const mode of ["control", "memory", "isolated", "overflow"]) {
          const isolated = mode === "isolated" || mode === "overflow";
          const turnCfg =
            mode === "memory"
              ? { ...cfg, plugins: { ...cfg.plugins, slots: { memory: plugin.id } } }
              : cfg;
          await state.writeConfig(turnCfg);
          setRuntimeConfigSnapshot(turnCfg);
          overflow = mode === "overflow";
          adopted = false;
          const sessionKey = "agent:public:telegram:alpha:group:guest:100:42:" + mode;
          const target = {
            agentId: "public",
            sessionId: "stored-" + mode,
            sessionKey,
            storePath: cfg.session!.store!,
          };
          await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: Date.now() });
          const transcript = await SessionManager.openAsync(target, state.workspaceDir);
          await transcript.appendMessageAsync({
            role: "user",
            content: "PRIVATE_HISTORY_CANARY",
            timestamp: 1,
          });
          await transcript.appendMessageAsync(
            makeAssistantMessageFixture({
              provider: "fixture",
              model: "public-model",
              api: "openai-completions",
              content: [{ type: "text", text: "Prior private answer" }],
            }),
          );
          const reply = await getReplyFromConfig(
            {
              Body: "PUBLIC_QUESTION",
              BodyForAgent: "PUBLIC_QUESTION",
              RawBody: "PUBLIC_QUESTION",
              AgentId: "public",
              SessionKey: sessionKey,
              Provider: "telegram",
              Surface: "telegram",
              AccountId: "alpha",
              ChatType: isolated ? "group" : "direct",
              From: "telegram:guest:42",
              To: "telegram:guest:100",
              SenderId: "42",
              MessageSid: mode,
              CommandAuthorized: false,
              InboundAccessAuthorized: true,
              WasMentioned: true,
            },
            {
              ...(isolated
                ? { isolatedContext: true as const, bootstrapContextMode: "lightweight" as const }
                : {}),
              ...(!isolated ? { disableTools: true } : {}),
              disableBlockStreaming: true,
              sourceReplyDeliveryMode: "automatic",
              turnAdoptionLifecycle: {
                onAdopted: () => {
                  adopted = true;
                },
                onDeferred: () => {},
                onAbandoned: () => {},
              },
            },
            withFullRuntimeReplyConfig(turnCfg),
          );
          expect(JSON.stringify(reply)).toContain(overflow ? "Context overflow" : "PUBLIC_REPLY");
          expect(JSON.stringify(await loadTranscriptEvents(target))).toContain(
            "PRIVATE_HISTORY_CANARY",
          );
        }
        expect(requests).toHaveLength(4);
        expect(adoptedAtModelIo).toEqual([true, true, true, true]);
        const control = JSON.stringify(requests[0]);
        expect(control).toContain("PRIVATE_USER_CANARY");
        expect(control).toContain("PRIVATE_WORKSPACE_MEMORY_CANARY");
        expect(control).toContain("PRIVATE_HISTORY_CANARY");
        expect(control).toContain("PRIVATE_BOOTSTRAP_HOOK_CANARY");
        expect(control).toContain("PRIVATE_PROMPT_MEMORY_CANARY");
        expect(control).toContain("PRIVATE_ENGINE_CANARY");
        expect(control).toContain("PRIVATE_TURN_PREPARE_CANARY");
        expect(JSON.stringify(requests.slice(2))).not.toContain("PRIVATE_");
        expect(JSON.stringify(requests[1])).toContain("PRIVATE_MEMORY_PROVIDER_CANARY");
        expect(requests[2]?.model).toBe("public-model");
        expect(JSON.stringify(requests[2])).toContain("PUBLIC_QUESTION");
        expect(JSON.stringify(requests[2])).not.toContain("PRIVATE_");
        expect(requests[2]?.tools ?? []).toEqual([]);
        const nativeCfg: OpenClawConfig = {
          ...cfg,
          agents: {
            ...cfg.agents,
            defaults: {
              ...cfg.agents!.defaults,
              model: { primary: "fixture/public-model", fallbacks: ["fallback/fallback-model"] },
            },
          },
          models: {
            providers: {
              fixture: {
                ...cfg.models!.providers!.fixture!,
                agentRuntime: { id: "unsafe-native" },
              },
              fallback: {
                ...cfg.models!.providers!.fixture!,
                models: [modelDefinition("fallback-model")],
              },
            },
          },
        };
        for (const primary of ["fixture/public-model", "claude-cli/claude-sonnet-4-6"]) {
          nativeCfg.agents!.defaults!.model = { primary, fallbacks: ["fallback/fallback-model"] };
          await state.writeConfig(nativeCfg);
          setRuntimeConfigSnapshot(nativeCfg);
          const refused = await getReplyFromConfig(
            {
              Body: "PUBLIC_QUESTION",
              SessionKey: "agent:public:telegram:alpha:group:guest:100:42:refused:" + primary,
              Provider: "telegram",
              ChatType: "group",
              AccountId: "alpha",
              From: "telegram:guest:42",
              To: "telegram:guest:100",
              SenderId: "42",
              WasMentioned: true,
              CommandAuthorized: false,
              InboundAccessAuthorized: true,
            },
            { isolatedContext: true, sourceReplyDeliveryMode: "automatic" },
            withFullRuntimeReplyConfig(nativeCfg),
          );
          expect(JSON.stringify(refused)).toContain("Strictly isolated replies are not supported");
          expect(requests).toHaveLength(4);
        }
      } finally {
        clearInternalHooks();
        clearRuntimeConfigSnapshot();
        await resetPreparedModelRuntimeSnapshotsForTest();
        await clearActivePluginRegistry();
        resetPluginLoaderTestStateForTest();
        cleanupPluginLoaderFixturesForTest();
        await closeHttpServer(server);
      }
    },
  );
});
