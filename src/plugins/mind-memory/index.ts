import path from "node:path";
import { fileURLToPath } from "node:url";
import { complete } from "@mariozechner/pi-ai";
import type { Command } from "commander";
import { resolveOpenClawAgentDir } from "../../agents/agent-paths.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { resolveModel } from "../../agents/pi-embedded-runner/model.js";
import type { OpenClawPluginApi } from "../../plugins/types.js";
import { ConsolidationService } from "../../services/memory/ConsolidationService.js";
import { GraphService } from "../../services/memory/GraphService.js";
import { SubconsciousService, type LLMClient } from "../../services/memory/SubconsciousService.js";
import { ensureGraphitiDocker, installDocker } from "./docker.js";

/** Typed shape of the mind-memory plugin config within the global config. */
type MindMemoryPluginConfig = {
  debug?: boolean;
  memoryDir?: string;
  graphiti?: { baseUrl?: string; autoStart?: boolean };
  narrative?: {
    enabled?: boolean;
    autoBootstrapHistory?: boolean;
    provider?: string;
    model?: string;
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
              const storyPath = path.join(path.dirname(memoryDir), "STORY.md");

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
      // Bootstrap historical episodes BEFORE flashback retrieval (if graph is empty)
      const agentId = resolveDefaultAgentId(api.config);
      const workspaceDir = resolveAgentWorkspaceDir(api.config, agentId);
      const memoryDir = config.memoryDir || path.join(workspaceDir, "memory");
      await consolidator.bootstrapHistoricalEpisodes(sessionId, memoryDir);

      const flashbacks = await subconscious.getFlashback(
        sessionId,
        prompt,
        llmClient as LLMClient | null,
        oldestContextTimestamp ? new Date(oldestContextTimestamp) : undefined,
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
  api.on("before_reset", (event, ctx) => {
    const { messages } = event;
    if (!messages || messages.length === 0) {
      return;
    }

    void (async () => {
      try {
        const agentId = resolveDefaultAgentId(api.config);
        const workspaceDir = ctx.workspaceDir ?? resolveAgentWorkspaceDir(api.config, agentId);
        const storyPath = path.join(workspaceDir, "STORY.md");
        const agentDir = resolveOpenClawAgentDir();
        const debug = !!config.debug;

        // Resolve narrative model from config or fallback to main agent model
        const narrativeProvider =
          (config.narrative as { provider?: string } | undefined)?.provider ?? "github-copilot";
        const narrativeModel =
          (config.narrative as { model?: string } | undefined)?.model ?? "gemini-2.0-flash-001";

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

        // Create a subconscious agent for the narrative LLM call
        const { createSubconsciousAgent } =
          await import("../../agents/pi-embedded-runner/subconscious-agent.js");
        const subconsciousAgent = createSubconsciousAgent({
          model,
          authStorage,
          modelRegistry,
          debug,
          autoBootstrapHistory: false,
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

  api.logger.info("Mind Memory plugin registered (Mind v1.0 Modular)");
  api.logger.info("  └─ Tool registered: remember (Conscious Access)");
}
