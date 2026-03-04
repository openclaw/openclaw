import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { complete } from "@mariozechner/pi-ai";
import type { Command } from "commander";
import { resolveOpenClawAgentDir } from "../../agents/agent-paths.js";
import {
  resolveAgentNarrativeDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { resolveModel } from "../../agents/pi-embedded-runner/model.js";
import type { AuthStorage } from "../../agents/pi-model-discovery.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import type { OpenClawPluginApi } from "../../plugins/types.js";
import { ConsolidationService } from "../../services/memory/ConsolidationService.js";
import { GraphService } from "../../services/memory/GraphService.js";
import {
  SubconsciousService,
  type LLMClient,
  type RecentMessage,
} from "../../services/memory/SubconsciousService.js";
import { ensureGraphitiDocker, installDocker } from "./docker.js";

/** Typed shape of the mind-memory plugin config within the global config. */
type MindMemoryPluginConfig = {
  debug?: boolean;
  memoryDir?: string;
  graphiti?: {
    enabled?: boolean;
    autoStart?: boolean;
    baseUrl?: string;
    rewriteMemories?: boolean;
    model?: string;
    thinking?: string;
  };
  narrative?: {
    enabled?: boolean;
    autoBootstrapStory?: boolean;
    model?: string;
    thinking?: string;
  };
};

// Use the real plugin API type so api.on() is available
type PluginApi = OpenClawPluginApi;

/** Extract the mind-memory plugin config from the global config. */
function getMindMemoryConfig(globalConfig: Record<string, unknown>): MindMemoryPluginConfig {
  const plugins = globalConfig?.plugins as Record<string, unknown> | undefined;
  const entries = plugins?.entries as Record<string, Record<string, unknown>> | undefined;
  const mindEntry = entries?.["mind-memory"];
  return (mindEntry?.config as MindMemoryPluginConfig) || {};
}

export default function register(api: PluginApi) {
  const config = getMindMemoryConfig(api.config);
  const graphitiUrl = config.graphiti?.baseUrl || "http://localhost:8001";
  const debug = !!config.debug;

  const graphService = new GraphService(graphitiUrl, debug);
  const subconscious = new SubconsciousService(graphService, debug);
  const consolidator = new ConsolidationService(graphService, debug);

  /**
   * Helper to wrap AuthStorage with automatic Copilot token exchange.
   * This ensures background tasks (narrative, graphiti) can authenticate
   * even if the primary model is local and hasn't triggered exchange.
   */
  function wrapAuthStorage(base: AuthStorage): AuthStorage {
    return {
      getApiKey: async (provider: string) => {
        const key = await base.getApiKey(provider);
        if (provider === "github-copilot" && key && key.startsWith("gh")) {
          try {
            const { resolveCopilotApiToken } =
              await import("../../providers/github-copilot-token.js");
            const { token } = await resolveCopilotApiToken({ githubToken: key });
            return token;
          } catch (err) {
            api.logger.warn(`[mind-memory] Copilot token exchange failed: ${String(err)}`);
          }
        }
        return key;
      },
    };
  }

  api.logger.info(`[mind-memory] Initializing with debug=${debug}`);

  // 1. Register Background Service for Docker management
  api.registerService({
    id: "mind-memory-docker",
    start: async () => {
      if (config.graphiti?.autoStart) {
        // Resolve plugin dir (root of src/plugins/mind-memory or dist/plugins/mind-memory)
        const pluginDir = path.dirname(fileURLToPath(import.meta.url));
        await ensureGraphitiDocker(pluginDir);
      }
    },
    stop: async () => {
      // We usually don't want to stop Graphiti automatically as it's shared
    },
  });

  // 1.1 Register CLI Command for Setup
  api.registerCli(
    ({ program }: { program: Command }) => {
      const parent = program.command("mind-memory").description("Mind Memory commands");

      parent
        .command("setup")
        .description("Prepare the environment for Mind Memory (Installs Docker if missing)")
        .option(
          "--bootstrap",
          "Force generate historical autobiography (STORY.md) from legacy files",
        )
        .action(async (options: Record<string, unknown>) => {
          const ok = await installDocker();
          if (ok) {
            api.logger.info("✅ Docker installation process finished. Now starting Graphiti...");
            const pluginDir = path.dirname(fileURLToPath(import.meta.url));
            await ensureGraphitiDocker(pluginDir);

            if (options.bootstrap) {
              api.logger.info("📖 Generating historical autobiography...");
              const sessionId = "global-user-memory";
              const agentId = resolveDefaultAgentId(api.config);
              const workspaceDir = resolveAgentWorkspaceDir(api.config, agentId);
              const memoryDir = config.memoryDir || path.join(workspaceDir, "memory");
              const narrativeDir = resolveAgentNarrativeDir(api.config, agentId);
              await import("node:fs/promises").then((fsPromises) =>
                fsPromises.mkdir(narrativeDir, { recursive: true }),
              );
              const storyPath = path.join(narrativeDir, "STORY.md");

              // We need a lightweight agent for this
              const agentDir = path.dirname(pluginDir);
              const { model: llm, error } = resolveModel(
                "github-copilot",
                "gemini-3-flash-preview",
                agentDir,
                api.config,
              );

              if (llm) {
                const { resolveApiKeyForProvider } = await import("../../agents/model-auth.js");
                const auth = await resolveApiKeyForProvider({
                  provider: "github-copilot",
                  cfg: api.config,
                  agentDir,
                });

                if (!auth.apiKey) {
                  api.logger.error(
                    "❌ No GitHub token found. Please configure it or set GITHUB_TOKEN environment variable.",
                  );
                  return;
                }

                let runtimeKey = auth.apiKey;
                if (auth.apiKey.startsWith("gh")) {
                  const { resolveCopilotApiToken } =
                    await import("../../providers/github-copilot-token.js");
                  const copilotAuth = await resolveCopilotApiToken({ githubToken: auth.apiKey });
                  runtimeKey = copilotAuth.token;
                }

                // Simple bridge for the consolidation service
                const bridge = {
                  complete: async (prompt: string) => {
                    // Bridge to pi-ai's complete function (external library with loose typing)
                    const res = await (complete as Function)(
                      llm,
                      { messages: [{ role: "user", content: prompt }] },
                      { apiKey: runtimeKey },
                    );
                    return { text: (res as unknown as { content?: string }).content || "" };
                  },
                };
                await consolidator.bootstrapFromLegacyMemory(
                  sessionId,
                  storyPath,
                  bridge,
                  "You are a helpful assistant.",
                  100000,
                  memoryDir,
                );
                api.logger.info("✅ Historical autobiography generated.");
              } else {
                api.logger.error(`❌ Could not resolve model: ${error}`);
              }
            }
          } else {
            api.logger.error("❌ Setup failed.");
          }
        });
    },
    { commands: ["mind-memory"] },
  );

  // 2. Register Gateway Methods for the core agent runner to call
  // This allows the runner to be decoupled from the internal implementation.
  api.registerGatewayMethod("narrative.getFlashbacks", async ({ params, respond }) => {
    const { prompt, oldestContextTimestamp, llmClient } = params as {
      prompt: string;
      oldestContextTimestamp?: string;
      llmClient: unknown;
    };

    // Use stable global ID to ensure memory persists across chat sessions
    const sessionId = "global-user-memory";
    try {
      // Resolve overrides
      const subconsciousOverride = config.graphiti?.model || config.narrative?.model;
      let activeClient = llmClient as LLMClient | null;

      if (subconsciousOverride) {
        try {
          const agentDir = resolveOpenClawAgentDir();
          const [provider, modelName] = subconsciousOverride.includes("/")
            ? subconsciousOverride.split("/")
            : ["github-copilot", subconsciousOverride];

          const { model, authStorage, modelRegistry } = resolveModel(
            provider,
            modelName,
            agentDir,
            api.config,
          );

          if (model) {
            if (debug) {
              api.logger.info(`🧠 [MIND] Using subconscious override: ${provider}/${modelName}`);
            }
            const { createSubconsciousAgent } =
              await import("../../agents/pi-embedded-runner/subconscious-agent.js");
            activeClient = createSubconsciousAgent({
              model,
              authStorage: wrapAuthStorage(authStorage),
              modelRegistry,
              debug,
              autoBootstrapHistory: false,
              fallbacks: api.config.agents?.defaults?.model?.fallbacks,
              reasoning: config.graphiti?.thinking as
                | import("@mariozechner/pi-ai").ThinkingLevel
                | undefined,
            });
          }
        } catch (err) {
          api.logger.warn(`[mind-memory] Failed to resolve subconscious override: ${String(err)}`);
        }
      }

      // Bootstrap historical episodes BEFORE flashback retrieval (if graph is empty)
      const agentId = resolveDefaultAgentId(api.config);
      const workspaceDir = resolveAgentWorkspaceDir(api.config, agentId);
      const memoryDir = config.memoryDir || path.join(workspaceDir, "memory");
      const narrativeDir = resolveAgentNarrativeDir(api.config, agentId);
      await consolidator.bootstrapHistoricalEpisodes(sessionId, memoryDir);

      // Read QUICK.md for observer context
      const { readFile } = await import("node:fs/promises");
      const quickContext = await readFile(path.join(narrativeDir, "QUICK.md"), "utf-8").catch(
        () => undefined,
      );

      const flashbacks = await subconscious.getFlashback(
        sessionId,
        prompt,
        activeClient,
        oldestContextTimestamp ? new Date(oldestContextTimestamp) : undefined,
        [],
        undefined,
        quickContext,
        config.graphiti?.rewriteMemories ?? true,
      );
      respond(true, { flashbacks });
    } catch (e: unknown) {
      respond(false, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  // REMOVED: narrative.consolidate gateway - Graphiti extracts entities automatically from episodes

  api.registerGatewayMethod("narrative.addEpisode", async ({ params, respond }) => {
    const { text } = params as { text: string };
    const sessionId = "global-user-memory";
    try {
      await graphService.addEpisode(sessionId, text);
      respond(true, { ok: true });
    } catch (e: unknown) {
      respond(false, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  api.registerGatewayMethod("narrative.searchNodes", async ({ params, respond }) => {
    const { query } = params as { query: string };
    const sessionId = "global-user-memory";
    try {
      const nodes = await graphService.searchNodes(sessionId, query);
      respond(true, { nodes });
    } catch (e: unknown) {
      respond(false, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  api.registerGatewayMethod("narrative.searchFacts", async ({ params, respond }) => {
    const { query } = params as { query: string };
    const sessionId = "global-user-memory";
    try {
      const facts = await graphService.searchFacts(sessionId, query);
      respond(true, { facts });
    } catch (e: unknown) {
      respond(false, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 3. Register Explicit Tool for Conscious Memory Access
  api.registerTool({
    name: "remember",
    label: "remember",
    description:
      "Search the long-term knowledge graph for memories, facts, and entities related to a query. Use this when you need to explicitly recall information from previous conversations or specific details about the user that might not be in the immediate context.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query keywords to find relevant memories.",
        },
      },
      required: ["query"],
    },
    execute: async (_toolCallId: string, params: { query: string }) => {
      const { query } = params;
      const sessionId = "global-user-memory";

      try {
        const [nodes, facts] = await Promise.all([
          graphService.searchNodes(sessionId, query),
          graphService.searchFacts(sessionId, query),
        ]);

        const combined = [...nodes, ...facts];

        if (combined.length === 0) {
          return {
            content: [{ type: "text", text: "No relevant memories found." }],
            details: null,
          };
        }

        // Simple formatting for the tool result
        const lines = combined
          .map((item) => {
            const content =
              (typeof item.content === "string" ? item.content : null) ||
              (typeof item.fact === "string" ? item.fact : null) ||
              JSON.stringify(item);
            const date = item.timestamp
              ? `[${new Date(item.timestamp as string | number | Date).toISOString().split("T")[0]}] `
              : "";
            return `- ${date}${content}`;
          })
          .slice(0, 20); // Limit to top 20 to avoid overwhelming

        return {
          content: [
            {
              type: "text",
              text: `Found ${combined.length} memories:\n${lines.join("\n")}`,
            },
          ],
          details: null,
        };
      } catch (e: unknown) {
        return {
          content: [{ type: "text", text: `Error searching memory: ${(e as Error).message}` }],
          isError: true,
          details: null,
        };
      }
    },
  });

  // 4. Register before_reset hook to sync the ending session to STORY.md when /new or /reset is called.
  // This is fire-and-forget so it doesn't block the session reset.
  api.on("before_reset", (event, _ctx) => {
    const { messages } = event;
    if (!messages || messages.length === 0) {
      return;
    }

    void (async () => {
      try {
        const agentId = resolveDefaultAgentId(api.config);
        const narrativeDir = resolveAgentNarrativeDir(api.config, agentId);
        const { mkdir } = await import("node:fs/promises");
        await mkdir(narrativeDir, { recursive: true });
        const storyPath = path.join(narrativeDir, "STORY.md");
        const agentDir = resolveOpenClawAgentDir();
        const debug = !!config.debug;

        // Resolve narrative model from config or fallback to main agent model
        const consolidatorOverride = config.narrative?.model;
        const [narrativeProvider, narrativeModel] = consolidatorOverride
          ? consolidatorOverride.includes("/")
            ? consolidatorOverride.split("/")
            : ["github-copilot", consolidatorOverride]
          : ["github-copilot", "gemini-2.0-flash-001"];

        const { model, authStorage, modelRegistry, error } = resolveModel(
          narrativeProvider,
          narrativeModel,
          agentDir,
          api.config,
        );

        if (!model) {
          api.logger.warn(
            `[mind-memory] before_reset: could not resolve narrative model: ${error ?? "unknown"}`,
          );
          return;
        }

        if (debug) {
          api.logger.info(
            `🧠 [MIND] Story consolidation will use model: ${narrativeProvider}/${narrativeModel}`,
          );
        }

        // Create a subconscious agent for the narrative LLM call
        const { createSubconsciousAgent } =
          await import("../../agents/pi-embedded-runner/subconscious-agent.js");
        const subconsciousAgent = createSubconsciousAgent({
          model,
          authStorage: wrapAuthStorage(authStorage),
          modelRegistry,
          debug,
          autoBootstrapHistory: false,
          reasoning: (config.narrative?.thinking ??
            "low") as import("@mariozechner/pi-ai").ThinkingLevel,
        });

        // Map the raw hook messages to the shape syncStoryWithSession expects.
        // commands-core.ts parses the .jsonl and provides: { type: "message", message: { role, text } }
        type MessageEntry = {
          role?: string;
          text?: string;
          content?: unknown;
          timestamp?: number | string;
          created_at?: string;
        };
        const sessionMessages = (messages as MessageEntry[]).filter(
          (m): m is MessageEntry & { role: string } =>
            typeof m.role === "string" && m.role !== "system",
        );

        if (sessionMessages.length === 0) {
          return;
        }

        if (debug) {
          process.stderr.write(
            `🧠 [MIND] before_reset: syncing ${sessionMessages.length} messages to STORY.md...\n`,
          );
        }

        const { ConsolidationService: CS } =
          await import("../../services/memory/ConsolidationService.js");
        const { GraphService: GS } = await import("../../services/memory/GraphService.js");
        const gUrl = config.graphiti?.baseUrl || "http://localhost:8001";
        const gs = new GS(gUrl, debug);
        const cons = new CS(gs, debug);

        await cons.syncStoryWithSession(
          sessionMessages,
          storyPath,
          subconsciousAgent,
          undefined,
          50000,
        );

        if (debug) {
          process.stderr.write(`✅ [MIND] before_reset: STORY.md sync complete.\n`);
        }
      } catch (err: unknown) {
        api.logger.warn(`[mind-memory] before_reset hook failed: ${String(err)}`);
      }
    })();
  });

  // Shared helper: resolve narrative LLM client + lighter observer client for query generation.
  // Called fresh each time (auth tokens may rotate between calls).
  const resolveNarrativeAgents = async (): Promise<{
    narrativeAgent: LLMClient;
    observerAgent: LLMClient;
  } | null> => {
    const agentDir = resolveOpenClawAgentDir();
    const consolidatorOverride = config.narrative?.model;
    const [narrativeProvider, narrativeModel] = consolidatorOverride
      ? consolidatorOverride.includes("/")
        ? consolidatorOverride.split("/")
        : ["github-copilot", consolidatorOverride]
      : ["github-copilot", "gemini-2.0-flash-001"];

    const { model, authStorage, modelRegistry, error } = resolveModel(
      narrativeProvider,
      narrativeModel,
      agentDir,
      api.config,
    );

    if (!model) {
      api.logger.warn(`[mind-memory] could not resolve narrative model: ${error ?? "unknown"}`);
      return null;
    }

    const { createSubconsciousAgent } =
      await import("../../agents/pi-embedded-runner/subconscious-agent.js");
    const narrativeAgent = createSubconsciousAgent({
      model,
      authStorage: wrapAuthStorage(authStorage),
      modelRegistry,
      debug,
      autoBootstrapHistory: false,
      reasoning: (config.narrative?.thinking ??
        "low") as import("@mariozechner/pi-ai").ThinkingLevel,
    });

    // Observer: no reasoning for low-latency query generation.
    const graphitiModelOverride = config.graphiti?.model;
    let observerAgent: LLMClient = narrativeAgent;
    if (graphitiModelOverride) {
      const [oProvider, oModel] = graphitiModelOverride.includes("/")
        ? graphitiModelOverride.split("/")
        : ["github-copilot", graphitiModelOverride];
      const {
        model: oM,
        authStorage: oAs,
        modelRegistry: oMr,
      } = resolveModel(oProvider, oModel, agentDir, api.config);
      if (oM) {
        observerAgent = createSubconsciousAgent({
          model: oM,
          authStorage: wrapAuthStorage(oAs),
          modelRegistry: oMr,
          debug,
          autoBootstrapHistory: false,
          // No reasoning — latency-sensitive query generation
        });
      }
    }

    return { narrativeAgent, observerAgent };
  };

  // 5. Register before_message_process hook: full per-message memory pipeline.
  // Returns narrativeStory (for system prompt injection) and extraSystemContext (flashback resonance).
  api.on("before_message_process", async (event, _ctx) => {
    // Skip for subagents — personal memory only applies to the top-level conversation.
    if (event.isSubagent) {
      return;
    }

    // Skip heartbeat probes (not real user messages).
    const { prompt } = event;
    if (
      (prompt.includes("Read HEARTBEAT.md") && prompt.includes("HEARTBEAT_OK")) ||
      prompt.trim() === "HEARTBEAT_OK"
    ) {
      return;
    }

    const agentId = resolveDefaultAgentId(api.config);
    const workspaceDir = resolveAgentWorkspaceDir(api.config, agentId);
    const memoryDir = config.memoryDir || path.join(workspaceDir, "memory");
    const narrativeDir = resolveAgentNarrativeDir(api.config, agentId);
    const storyPath = path.join(narrativeDir, "STORY.md");
    const quickPath = path.join(narrativeDir, "QUICK.md");
    const sessionsDir = event.sessionFile ? path.dirname(event.sessionFile) : undefined;

    await mkdir(narrativeDir, { recursive: true });

    // One-time migration: copy STORY.md from workspace root if narrativeDir version is missing.
    try {
      await access(storyPath);
    } catch {
      try {
        await copyFile(path.join(workspaceDir, "STORY.md"), storyPath);
        if (debug) {
          api.logger.info(`🧠 [MIND] Migrated STORY.md from workspace to narrativeDir`);
        }
      } catch {
        // No workspace STORY.md either — new user, will be created on first sync
      }
    }

    // Read STORY.md and QUICK.md for context injection.
    const [storyContent, quickContext] = await Promise.all([
      readFile(storyPath, "utf-8").catch(() => undefined),
      readFile(quickPath, "utf-8").catch(() => undefined),
    ]);

    const agents = await resolveNarrativeAgents();
    if (!agents) {
      return { narrativeStory: storyContent };
    }
    const { narrativeAgent, observerAgent } = agents;

    const sessionId = "global-user-memory";
    const skipResonance = process.env.MIND_SKIP_RESONANCE === "1";

    // Run memory pipeline in parallel:
    // [0] Bootstrap historical episodes into Graphiti (idempotent flag-file check)
    // [1] Sync global narrative from recent session files (fire-and-forget QUICK.md regen)
    // [2] Add current prompt as a graph episode
    // [3] Get flashback resonance for injection
    const [, , , flashbackResult] = await Promise.allSettled([
      config.graphiti?.enabled !== false
        ? consolidator.bootstrapHistoricalEpisodes(sessionId, memoryDir)
        : Promise.resolve(),
      sessionsDir && config.narrative?.enabled !== false
        ? consolidator
            .syncGlobalNarrative(
              sessionsDir,
              storyPath,
              narrativeAgent,
              undefined,
              50000,
              event.sessionFile,
            )
            .then(() =>
              consolidator
                .generateQuickProfile(storyPath, quickPath, workspaceDir, narrativeAgent)
                .catch(() => {}),
            )
            .catch(() => {})
        : Promise.resolve(),
      config.graphiti?.enabled !== false
        ? graphService.addEpisode(sessionId, `user: ${prompt}`, event.timestamp)
        : Promise.resolve(),
      !skipResonance && config.graphiti?.enabled !== false
        ? subconscious.getFlashback(
            sessionId,
            prompt,
            narrativeAgent,
            undefined,
            (event.recentMessages ?? []) as RecentMessage[],
            undefined,
            quickContext,
            config.graphiti?.rewriteMemories ?? true,
            observerAgent,
            (evt) => {
              if (event.sessionKey && _ctx.runId) {
                emitAgentEvent({
                  runId: _ctx.runId,
                  sessionKey: event.sessionKey,
                  stream: evt.stream,
                  data: evt.data,
                });
              }
            },
          )
        : Promise.resolve(""),
    ]);

    const flashback =
      flashbackResult.status === "fulfilled" && typeof flashbackResult.value === "string"
        ? flashbackResult.value
        : undefined;

    return {
      narrativeStory: storyContent,
      extraSystemContext: flashback || undefined,
    };
  });

  // 6. Register before_compaction hook: sync STORY.md from the pre-compaction message history.
  // Fire-and-forget so it does not block the compaction LLM call.
  api.on("before_compaction", (event, _ctx) => {
    const { messages, sessionFile } = event;
    if (!messages || messages.length === 0 || config.narrative?.enabled === false) {
      return;
    }

    void (async () => {
      try {
        const agentId = resolveDefaultAgentId(api.config);
        const workspaceDir = resolveAgentWorkspaceDir(api.config, agentId);
        const narrativeDir = resolveAgentNarrativeDir(api.config, agentId);
        const storyPath = path.join(narrativeDir, "STORY.md");
        const quickPath = path.join(narrativeDir, "QUICK.md");

        const agents = await resolveNarrativeAgents();
        if (!agents) {
          return;
        }
        const { narrativeAgent } = agents;

        type MsgEntry = {
          role?: string;
          text?: string;
          content?: unknown;
          timestamp?: number | string;
          created_at?: string;
        };
        const sessionMessages = (messages as MsgEntry[]).filter(
          (m): m is MsgEntry & { role: string } =>
            typeof m.role === "string" && m.role !== "system",
        );

        if (sessionMessages.length === 0) {
          return;
        }

        if (debug) {
          api.logger.info(
            `🧠 [MIND] before_compaction: syncing ${sessionMessages.length} messages to STORY.md...`,
          );
        }

        await consolidator.syncStoryWithSession(
          sessionMessages,
          storyPath,
          narrativeAgent,
          undefined,
          50000,
          (evt) => {
            if (_ctx.runId && _ctx.sessionKey) {
              emitAgentEvent({
                runId: _ctx.runId,
                sessionKey: _ctx.sessionKey,
                stream: evt.stream,
                data: evt.data,
              });
            }
          },
        );

        // Fire-and-forget QUICK.md regeneration after story sync.
        void consolidator
          .generateQuickProfile(storyPath, quickPath, workspaceDir, narrativeAgent)
          .catch(() => {});

        if (debug) {
          api.logger.info(`✅ [MIND] before_compaction: STORY.md sync complete.`);
        }

        void sessionFile; // sessionFile available if needed for future enhancements
      } catch (err: unknown) {
        api.logger.warn(`[mind-memory] before_compaction hook failed: ${String(err)}`);
      }
    })();
  });

  // 7. Register after_compaction hook: triggered on auto-compaction from the run loop.
  // Syncs any unprocessed messages from recent session files to STORY.md.
  api.on("after_compaction", (event, _ctx) => {
    const { sessionFile } = event;
    if (!sessionFile || config.narrative?.enabled === false) {
      return;
    }

    void (async () => {
      try {
        const sessionsDir = path.dirname(sessionFile);
        const agentId = resolveDefaultAgentId(api.config);
        const workspaceDir = resolveAgentWorkspaceDir(api.config, agentId);
        const narrativeDir = resolveAgentNarrativeDir(api.config, agentId);
        const storyPath = path.join(narrativeDir, "STORY.md");
        const quickPath = path.join(narrativeDir, "QUICK.md");

        const agents = await resolveNarrativeAgents();
        if (!agents) {
          return;
        }
        const { narrativeAgent } = agents;

        if (debug) {
          api.logger.info(
            `🧠 [MIND] after_compaction: syncing global narrative from ${sessionsDir}...`,
          );
        }

        await consolidator.syncGlobalNarrative(
          sessionsDir,
          storyPath,
          narrativeAgent,
          undefined,
          50000,
          sessionFile,
          (evt) => {
            if (_ctx.runId && _ctx.sessionKey) {
              emitAgentEvent({
                runId: _ctx.runId,
                sessionKey: _ctx.sessionKey,
                stream: evt.stream,
                data: evt.data,
              });
            }
          },
        );

        // Fire-and-forget QUICK.md regeneration after story sync.
        void consolidator
          .generateQuickProfile(storyPath, quickPath, workspaceDir, narrativeAgent)
          .catch(() => {});

        if (debug) {
          api.logger.info(`✅ [MIND] after_compaction: global narrative sync complete.`);
        }
      } catch (err: unknown) {
        api.logger.warn(`[mind-memory] after_compaction hook failed: ${String(err)}`);
      }
    })();
  });

  api.logger.info("Mind Memory plugin registered (Mind v1.0 Modular)");
  api.logger.info("  └─ Tool registered: remember (Conscious Access)");
}
