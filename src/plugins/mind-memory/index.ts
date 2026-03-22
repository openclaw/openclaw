import { spawn } from "node:child_process";
import fs from "node:fs";
import { access, copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { complete } from "@mariozechner/pi-ai";
import type { AuthStorage as PiAuthStorage } from "@mariozechner/pi-coding-agent";
import type { Command } from "commander";
import { resolveOpenClawAgentDir } from "../../agents/agent-paths.js";
import {
  resolveAgentNarrativeDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { resolveModel } from "../../agents/pi-embedded-runner/model.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { resolveSessionTranscriptsDirForAgent } from "../../config/sessions/paths.js";
import { readSessionMessages } from "../../gateway/session-utils.fs.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { LlamaCppCacheService } from "../../infra/LlamaCppCacheService.js";
import type { OpenClawPluginApi } from "../../plugins/types.js";
import { ConsolidationService } from "../../services/memory/ConsolidationService.js";
import { GraphService } from "../../services/memory/GraphService.js";
import {
  SubconsciousService,
  type LLMClient,
  type RecentMessage,
} from "../../services/memory/SubconsciousService.js";
import { ensureGraphitiDocker, installDocker } from "./docker.js";
import { readModeState, writeModeState } from "./intensive-mode.js";
import type { LlamaCppServerConfig, MindMemoryPluginConfig } from "./types.js";

// Use the real plugin API type so api.on() is available
type PluginApi = OpenClawPluginApi;

/** Fire-and-forget a desktop notification via ~/scripts/notify.sh. */
function sendNotify(message: string): void {
  const notifyScript = path.join(os.homedir(), "scripts", "notify.sh");
  const proc = spawn(notifyScript, [message], {
    stdio: "ignore",
    detached: true,
  });
  proc.unref();
}

/** Resolve chunk size for bootstrap from the graphiti (smallModel) contextWindow. */
function resolveBootstrapChunkSize(globalConfig: Record<string, unknown>): number {
  const smallModelRaw = (
    globalConfig as Record<string, unknown> & { agents?: { defaults?: { smallModel?: string } } }
  )?.agents?.defaults?.smallModel;
  if (!smallModelRaw?.includes("/")) {
    return 12000;
  }
  const [provider, ...modelParts] = smallModelRaw.split("/");
  const modelId = modelParts.join("/");
  const models = globalConfig?.models as
    | { providers?: Record<string, { models?: Array<{ id: string; contextWindow?: number }> }> }
    | undefined;
  const providers = models?.providers;
  const contextWindow = providers?.[provider]?.models?.find((m) => m.id === modelId)?.contextWindow;
  if (!contextWindow) {
    return 12000;
  }
  // Leave ~2000 tokens for graphiti extraction prompt + output; 3 chars per token
  return Math.max(4000, (contextWindow - 2000) * 3);
}

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
  // Track per-session message count for batched episode ingestion (every 8 messages)
  const sessionMessageCounters = new Map<string, number>();
  const llamaCache = new LlamaCppCacheService(debug);
  // Serializes KV cache slot swaps to prevent races if hyperfocus is toggled
  // while a concurrent request is in flight.
  let slotSwapQueue: Promise<void> = Promise.resolve();

  function enqueueSlotSwap(fn: () => Promise<void>): void {
    slotSwapQueue = slotSwapQueue.then(fn).catch(() => {});
  }

  /** Resolve the llama.cpp server whose URL matches a provider baseUrl from config. */
  function resolveLlamaCppServer(providerBaseUrl: string): LlamaCppServerConfig | undefined {
    const servers = config.llamacpp?.servers ?? [];
    return servers.find((s) => providerBaseUrl.startsWith(s.url.replace(/\/$/, "")));
  }

  /**
   * Helper to wrap AuthStorage with automatic Copilot token exchange.
   * This ensures background tasks (narrative, graphiti) can authenticate
   * even if the primary model is local and hasn't triggered exchange.
   */
  function wrapAuthStorage(base: PiAuthStorage): PiAuthStorage {
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
        // Resolve LLM config for Docker from smallModel provider
        const smallModelRaw = api.config.agents?.defaults?.smallModel;
        const [smProvider] = smallModelRaw?.includes("/")
          ? smallModelRaw.split("/", 2)
          : [undefined];
        const providerCfg = smProvider
          ? ((api.config as Record<string, unknown>)?.models?.providers?.[smProvider] as
              | { baseUrl?: string; apiKey?: string }
              | undefined)
          : undefined;
        const smModelName = smallModelRaw?.includes("/")
          ? smallModelRaw.split("/").slice(1).join("/")
          : undefined;
        await ensureGraphitiDocker(pluginDir, {
          apiUrl: providerCfg?.baseUrl,
          apiKey: providerCfg?.apiKey,
          modelName: smModelName,
          embedderModel: smModelName,
        });
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
              const sessionId = "global_user_memory";
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
    const sessionId = "global_user_memory";
    try {
      // Skip flashbacks in hyperfocus/intensive mode — no resonance during focused work.
      const modeAgentId = resolveDefaultAgentId(api.config);
      const modeNarrativeDir = resolveAgentNarrativeDir(api.config, modeAgentId);
      const modeState = await readModeState(modeNarrativeDir);
      if (modeState.mode === "intensive") {
        respond(true, { flashbacks: null });
        return;
      }

      // Resolve overrides — read fresh config so /graphitimodel changes apply immediately
      const freshSnapshot2 = await readConfigFileSnapshot();
      const freshCfg2 =
        freshSnapshot2.valid && freshSnapshot2.config ? freshSnapshot2.config : api.config;
      const agentDefaults = freshCfg2.agents?.defaults;
      const subconsciousOverride = agentDefaults?.smallModel || agentDefaults?.auxiliaryModel;
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
            freshCfg2,
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
              fallbacks:
                typeof api.config.agents?.defaults?.model === "object"
                  ? api.config.agents.defaults.model?.fallbacks
                  : undefined,
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
      const bootstrapSessionsDir = resolveSessionTranscriptsDirForAgent(agentId);

      // Read GLOSSARY.md for observer context
      const { readFile } = await import("node:fs/promises");
      const quickContext = await readFile(path.join(narrativeDir, "GLOSSARY.md"), "utf-8").catch(
        () => undefined,
      );

      await consolidator.bootstrapHistoricalEpisodes(
        sessionId,
        memoryDir,
        [],
        workspaceDir,
        resolveBootstrapChunkSize(api.config),
        bootstrapSessionsDir,
        activeClient ?? undefined,
        quickContext ?? undefined,
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
    const sessionId = "global_user_memory";
    try {
      await graphService.addEpisode(sessionId, text);
      respond(true, { ok: true });
    } catch (e: unknown) {
      respond(false, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  api.registerGatewayMethod("narrative.searchNodes", async ({ params, respond }) => {
    const { query } = params as { query: string };
    const sessionId = "global_user_memory";
    try {
      const nodes = await graphService.searchNodes(sessionId, query);
      respond(true, { nodes });
    } catch (e: unknown) {
      respond(false, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  api.registerGatewayMethod("narrative.searchFacts", async ({ params, respond }) => {
    const { query, recentMessages, sessionFile } = params as {
      query?: string;
      recentMessages?: RecentMessage[];
      sessionFile?: string;
    };
    const sessionId = "global_user_memory";
    try {
      let searchQuery = query?.trim() ?? "";

      // If no query provided, build recent messages from session file(s)
      let effectiveRecentMessages = recentMessages;
      if (!searchQuery && !effectiveRecentMessages?.length && sessionFile) {
        const sessionsDir = path.dirname(sessionFile);

        const extractMessages = (msgs: unknown[]): RecentMessage[] =>
          (msgs as Array<{ role?: string; content?: unknown; text?: string }>)
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => {
              let text = "";
              if (typeof m.content === "string") {
                text = m.content;
              } else if (Array.isArray(m.content)) {
                text = (m.content as Array<{ type?: string; text?: string }>)
                  .filter((p) => p.type === "text")
                  .map((p) => p.text ?? "")
                  .join(" ");
              } else if (typeof m.text === "string") {
                text = m.text;
              }
              return { role: (m.role ?? "user") as "user" | "assistant", text };
            });

        const currentMsgs = extractMessages(readSessionMessages("", undefined, sessionFile)).slice(
          -8,
        );

        // If current session has few user turns, supplement with the previous session
        const userTurns = currentMsgs.filter((m) => m.role === "user").length;
        if (userTurns < 3) {
          const allFiles = await readdir(sessionsDir).catch(() => [] as string[]);
          const otherFiles = allFiles
            .filter((f) => f.endsWith(".jsonl") && path.join(sessionsDir, f) !== sessionFile)
            .map((f) => ({ f, p: path.join(sessionsDir, f) }))
            .toSorted((a, b) => {
              try {
                return fs.statSync(b.p).mtimeMs - fs.statSync(a.p).mtimeMs;
              } catch {
                return 0;
              }
            });

          if (otherFiles[0]) {
            const prevMsgs = extractMessages(
              readSessionMessages("", undefined, otherFiles[0].p),
            ).slice(-8);
            effectiveRecentMessages = [...prevMsgs, ...currentMsgs].slice(-8);
          } else {
            effectiveRecentMessages = currentMsgs;
          }
        } else {
          effectiveRecentMessages = currentMsgs;
        }
      }

      // If no query provided, generate queries from recent messages using the observer
      if (!searchQuery && effectiveRecentMessages && effectiveRecentMessages.length > 0) {
        const agentId = resolveDefaultAgentId(api.config);
        const narrativeDir = resolveAgentNarrativeDir(api.config, agentId);
        const glossaryContext = await readFile(
          path.join(narrativeDir, "GLOSSARY.md"),
          "utf-8",
        ).catch(() => undefined);
        const agents = await resolveNarrativeAgents();
        if (agents) {
          const queriesStart = Date.now();
          const queries = await subconscious.generateSeekerQueries(
            "",
            effectiveRecentMessages,
            agents.observerAgent ?? agents.narrativeAgent,
            glossaryContext,
          );
          const queriesMs = Date.now() - queriesStart;
          if (queries.length > 0) {
            // Get session start time to filter out facts created after this session began
            let sessionStartMs = Date.now();
            if (sessionFile) {
              try {
                const firstLine = fs
                  .readFileSync(sessionFile, "utf-8")
                  .split(/\r?\n/)
                  .find((l) => l.trim());
                if (firstLine) {
                  const parsed = JSON.parse(firstLine);
                  const ts = parsed?.timestamp ?? parsed?.message?.timestamp;
                  if (ts) {
                    sessionStartMs = new Date(ts).getTime();
                  }
                }
              } catch {
                /* use now */
              }
            }

            const graphStart = Date.now();
            const results = await Promise.all(
              queries.map((q) => graphService.searchFacts(sessionId, q).catch(() => [])),
            );
            const graphMs = Date.now() - graphStart;
            const seen = new Set<string>();
            const combined = results
              .flat()
              .filter((f) => {
                const key =
                  (f as { uuid?: string; fact?: string; content?: string }).uuid ??
                  (f as { fact?: string }).fact ??
                  (f as { content?: string }).content ??
                  JSON.stringify(f);
                if (seen.has(key)) {
                  return false;
                }
                seen.add(key);
                // Filter out facts timestamped after the session started
                const fts = (f as { timestamp?: string }).timestamp;
                if (fts && new Date(fts).getTime() > sessionStartMs) {
                  return false;
                }
                return true;
              })
              .slice(0, queries.length * 3);
            respond(true, { facts: combined, query: queries[0], timings: { queriesMs, graphMs } });
            return;
          }
        }
      }

      if (!searchQuery) {
        respond(true, { facts: [] });
        return;
      }

      const graphStart = Date.now();
      const facts = await graphService.searchFacts(sessionId, searchQuery);
      const graphMs = Date.now() - graphStart;
      respond(true, { facts, query: searchQuery, timings: { queriesMs: 0, graphMs } });
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
      const sessionId = "global_user_memory";

      try {
        const facts = await graphService.searchFacts(sessionId, query);

        const combined = [...facts];

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

  // 3b. Hyperfocus mode tools
  api.registerTool({
    name: "activate_hyperfocus_mode",
    label: "activate_hyperfocus_mode",
    description:
      "Activates hyperfocus mode. In this mode the system injects a compact " +
      "narrative summary (SUMMARY.md) instead of the full STORY.md, suppresses peripheral " +
      "context files (SOUL.md, USER.md, MEMORY.md, IDENTITY.md), and disables Graphiti flashbacks. " +
      "Use this when starting a complex task that needs maximum context window space. " +
      "Tip: for best results, activate before starting a new session (/new) so no context-file " +
      "reads are already in the message history. " +
      "Optionally provide a 'goal' describing the task — it will be injected into every message " +
      "of the hyperfocus session so the objective stays visible even after a /new.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Optional reason for activating hyperfocus mode (logged for diagnostics).",
        },
        goal: {
          type: "string",
          description:
            "Optional task goal for this hyperfocus session (e.g. 'Implement the WebGPU keychain renderer'). " +
            "Stored in mode.json and re-injected into the system prompt on every message, " +
            "keeping the objective visible even after /new.",
        },
      },
      required: [],
    },
    execute: async (_toolCallId: string, params: { reason?: string; goal?: string }) => {
      try {
        const agentId = resolveDefaultAgentId(api.config);
        const workspaceDir = resolveAgentWorkspaceDir(api.config, agentId);
        const narrativeDir = resolveAgentNarrativeDir(api.config, agentId);
        await mkdir(narrativeDir, { recursive: true });

        const current = await readModeState(narrativeDir);
        if (current.mode === "intensive") {
          return {
            content: [{ type: "text", text: "Hyperfocus mode is already active." }],
            details: null,
          };
        }

        const storyPath = path.join(narrativeDir, "STORY.md");
        const summaryPath = path.join(narrativeDir, "SUMMARY.md");

        // SUMMARY.md must exist before activating intensive mode — generate it now if missing.
        let summaryExists = false;
        try {
          await access(summaryPath);
          summaryExists = true;
        } catch {
          /* will generate */
        }

        if (!summaryExists) {
          const agents = await resolveNarrativeAgents();
          if (!agents) {
            return {
              content: [
                {
                  type: "text",
                  text: "Cannot activate intensive mode: narrative model is not configured.",
                },
              ],
              isError: true,
              details: null,
            };
          }
          await consolidator.generateSummary(
            storyPath,
            summaryPath,
            workspaceDir,
            agents.narrativeAgent,
          );
          // Verify it was created
          try {
            await access(summaryPath);
          } catch {
            return {
              content: [
                {
                  type: "text",
                  text: "Cannot activate intensive mode: SUMMARY.md generation failed (STORY.md may be empty).",
                },
              ],
              isError: true,
              details: null,
            };
          }
        }

        await writeModeState(narrativeDir, {
          mode: "intensive",
          activatedAt: new Date().toISOString(),
          goal: params.goal?.trim() || undefined,
        });

        // Serialized KV cache slot swap: save normal slot, restore intensive slot
        const providerBaseUrl = resolveCurrentProviderBaseUrl();
        const server = providerBaseUrl ? resolveLlamaCppServer(providerBaseUrl) : undefined;
        if (server) {
          const normalSlot = server.slots?.normal ?? 0;
          const intensiveSlot = server.slots?.intensive ?? 1;
          enqueueSlotSwap(async () => {
            await llamaCache.saveSlot(server.url, normalSlot, "cache-normal.bin");
            await llamaCache.restoreSlot(server.url, intensiveSlot, "cache-intensive.bin");
          });
        }

        if (debug) {
          api.logger.info(
            `🎯 [MIND] Hyperfocus mode activated. Reason: ${params.reason ?? "unspecified"}. Goal: ${params.goal ?? "unspecified"}`,
          );
        }
        const goalLine = params.goal?.trim() ? ` Goal: ${params.goal.trim()}.` : "";
        return {
          content: [
            {
              type: "text",
              text: `Hyperfocus mode activated${!summaryExists ? " (SUMMARY.md generated)" : ""}.${goalLine} Using SUMMARY.md + no flashbacks. Next message will use compact context. For maximum effect, start a new session now with /new.`,
            },
          ],
          details: null,
        };
      } catch (e: unknown) {
        return {
          content: [
            { type: "text", text: `Error activating hyperfocus mode: ${(e as Error).message}` },
          ],
          isError: true,
          details: null,
        };
      }
    },
  });

  api.registerTool({
    name: "deactivate_hyperfocus_mode",
    label: "deactivate_hyperfocus_mode",
    description:
      "Deactivates hyperfocus mode and returns to normal mode. " +
      "STORY.md, SOUL.md, USER.md, MEMORY.md, IDENTITY.md and Graphiti flashbacks will be restored. " +
      "Provide a 'summary' with your own assessment of the session: what was accomplished, what changed, " +
      "and what remains pending. This summary is shown to the user as the session closing message " +
      "and stored as a Graphiti memory episode.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description:
            "Your assessment of the hyperfocus session: what was accomplished, what changed, " +
            "and what remains pending. Shown to the user and stored in long-term memory.",
        },
      },
      required: [],
    },
    execute: async (_toolCallId: string, params: { summary?: string }) => {
      try {
        const agentId = resolveDefaultAgentId(api.config);
        const narrativeDir = resolveAgentNarrativeDir(api.config, agentId);
        await mkdir(narrativeDir, { recursive: true });

        const current = await readModeState(narrativeDir);
        if (current.mode === "normal") {
          return { content: [{ type: "text", text: "Already in normal mode." }], details: null };
        }

        await writeModeState(narrativeDir, { mode: "normal" });

        // Serialized KV cache slot swap back
        const providerBaseUrl = resolveCurrentProviderBaseUrl();
        const server = providerBaseUrl ? resolveLlamaCppServer(providerBaseUrl) : undefined;
        if (server) {
          const normalSlot = server.slots?.normal ?? 0;
          const intensiveSlot = server.slots?.intensive ?? 1;
          enqueueSlotSwap(async () => {
            await llamaCache.saveSlot(server.url, intensiveSlot, "cache-intensive.bin");
            await llamaCache.restoreSlot(server.url, normalSlot, "cache-normal.bin");
          });
        }

        // Fire-and-forget: add a Graphiti episode summarising the hyperfocus session
        // so the focused work is not lost from long-term memory.
        // Prefer Mind's own summary; fall back to goal+duration if not provided.
        if (config.graphiti?.enabled !== false) {
          const sessionId = "global_user_memory";
          const durationMs = current.activatedAt
            ? Date.now() - new Date(current.activatedAt).getTime()
            : 0;
          const durationMin = Math.round(durationMs / 60_000);
          const goalPart = current.goal?.trim() ? ` Goal: ${current.goal.trim()}.` : "";
          const durationPart = durationMin > 0 ? ` Duration: ${durationMin} minutes.` : "";
          const episodeText = params.summary?.trim()
            ? `Hyperfocus session ended.${goalPart}${durationPart} ${params.summary.trim()}`
            : `Hyperfocus session ended.${goalPart}${durationPart}`;
          void graphService
            .addEpisode(sessionId, episodeText, new Date().toISOString())
            .catch(() => {});
          if (debug) {
            api.logger.info(`🔄 [MIND] Hyperfocus episode added to graph: "${episodeText}"`);
          }
        }

        if (debug) {
          api.logger.info(`🔄 [MIND] Hyperfocus mode deactivated, returning to normal.`);
        }
        const closingText = params.summary?.trim()
          ? params.summary.trim()
          : "Normal mode restored — full context and flashbacks active on next message.";
        return {
          content: [{ type: "text", text: closingText }],
          details: null,
        };
      } catch (e: unknown) {
        return {
          content: [
            { type: "text", text: `Error deactivating intensive mode: ${(e as Error).message}` },
          ],
          isError: true,
          details: null,
        };
      }
    },
  });

  // 4. Register before_reset hook: trigger narrative sync when /new or /reset is called.
  // Uses syncGlobalNarrative so it reads all sessions newer than STORY.md — no dependency on the closing session file.
  api.on("before_reset", (_event, _ctx) => {
    if (config.narrative?.enabled === false) {
      return;
    }

    void (async () => {
      try {
        const agentId = resolveDefaultAgentId(api.config);
        const narrativeDir = resolveAgentNarrativeDir(api.config, agentId);
        await mkdir(narrativeDir, { recursive: true });
        const storyPath = path.join(narrativeDir, "STORY.md");
        const glossaryPath = path.join(narrativeDir, "GLOSSARY.md");
        const summaryPath = path.join(narrativeDir, "SUMMARY.md");
        const workspaceDir = resolveAgentWorkspaceDir(api.config, agentId);
        const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);

        const agents = await resolveNarrativeAgents();
        if (!agents) {
          return;
        }

        await consolidator
          .syncGlobalNarrative(sessionsDir, storyPath, agents.narrativeAgent, undefined, 50000)
          .then(() =>
            Promise.all([
              consolidator
                .generateGlossary(storyPath, glossaryPath, workspaceDir, agents.narrativeAgent)
                .catch(() => {}),
              consolidator
                .generateSummary(storyPath, summaryPath, workspaceDir, agents.narrativeAgent)
                .catch(() => {}),
            ]),
          );
      } catch (err: unknown) {
        api.logger.warn(`[mind-memory] before_reset hook failed: ${String(err)}`);
      }
    })();
  });

  /** Returns the baseUrl of the currently configured primary provider, if any. */
  function resolveCurrentProviderBaseUrl(): string | undefined {
    const model = api.config.agents?.defaults?.model;
    const primaryRaw = typeof model === "string" ? model : model?.primary;
    if (!primaryRaw) {
      return undefined;
    }
    const provider = primaryRaw.includes("/") ? primaryRaw.split("/")[0] : undefined;
    if (!provider) {
      return undefined;
    }
    const providerCfg = api.config.models?.providers?.[provider];
    return providerCfg?.baseUrl;
  }

  // Shared helper: resolve narrative LLM client + lighter observer client for query generation.
  // Called fresh each time (auth tokens may rotate between calls).
  const resolveNarrativeAgents = async (): Promise<{
    narrativeAgent: LLMClient;
    observerAgent: LLMClient;
  } | null> => {
    const agentDir = resolveOpenClawAgentDir();
    // Read fresh config snapshot so model changes applied via /narrativemodel or
    // /graphitimodel take effect immediately without a gateway restart.
    // (agents.* keys are "dynamic reads" in config-reload.ts — no hot-reload action fires.)
    const freshSnapshot = await readConfigFileSnapshot();
    const freshCfg =
      freshSnapshot.valid && freshSnapshot.config ? freshSnapshot.config : api.config;

    const consolidatorOverride = freshCfg.agents?.defaults?.auxiliaryModel;
    const primaryModelRaw =
      typeof freshCfg.agents?.defaults?.model === "string"
        ? freshCfg.agents.defaults.model
        : freshCfg.agents?.defaults?.model?.primary;
    const modelSource = consolidatorOverride ?? primaryModelRaw;
    if (!modelSource) {
      api.logger.warn(
        "[mind-memory] could not resolve narrative model: no auxiliaryModel or primary model configured",
      );
      return null;
    }
    const [narrativeProvider, narrativeModel] = modelSource.includes("/")
      ? modelSource.split("/")
      : ["github-copilot", modelSource];

    const { model, authStorage, modelRegistry, error } = resolveModel(
      narrativeProvider,
      narrativeModel,
      agentDir,
      freshCfg,
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
    const graphitiModelOverride = freshCfg.agents?.defaults?.smallModel;
    let observerAgent: LLMClient = narrativeAgent;
    if (graphitiModelOverride) {
      const [oProvider, oModel] = graphitiModelOverride.includes("/")
        ? graphitiModelOverride.split("/")
        : ["github-copilot", graphitiModelOverride];
      const {
        model: oM,
        authStorage: oAs,
        modelRegistry: oMr,
      } = resolveModel(oProvider, oModel, agentDir, freshCfg);
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
    const glossaryPath = path.join(narrativeDir, "GLOSSARY.md");
    const summaryPath = path.join(narrativeDir, "SUMMARY.md");
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

    // Read mode state to determine context injection strategy.
    const modeState = await readModeState(narrativeDir);
    const isIntensive = modeState.mode === "intensive";

    // Read STORY.md, SUMMARY.md and GLOSSARY.md for context injection.
    const [storyContent, summaryContent, quickContext] = await Promise.all([
      readFile(storyPath, "utf-8").catch(() => undefined),
      readFile(summaryPath, "utf-8").catch(() => undefined),
      readFile(glossaryPath, "utf-8").catch(() => undefined),
    ]);

    // If GLOSSARY.md doesn't exist yet, generate it now (first-run bootstrap).
    if (!quickContext) {
      const agents = await resolveNarrativeAgents();
      if (agents) {
        void consolidator
          .generateGlossary(storyPath, glossaryPath, workspaceDir, agents.narrativeAgent)
          .catch(() => {});
      }
    }

    // In intensive mode: use SUMMARY (fallback to STORY), suppress peripheral files, skip flashbacks.
    if (isIntensive) {
      const agents = await resolveNarrativeAgents();
      if (agents) {
        // Fire-and-forget: keep SUMMARY and QUICK up to date
        void Promise.all([
          consolidator
            .generateSummary(storyPath, summaryPath, workspaceDir, agents.narrativeAgent)
            .catch(() => {}),
          consolidator
            .generateGlossary(storyPath, glossaryPath, workspaceDir, agents.narrativeAgent)
            .catch(() => {}),
        ]);
      }
      // Stable behavioral hints go into extraSystemPrompt (injected into system prompt,
      // cached by the model server). Dynamic content (flashbacks) would use extraSystemContext.
      const startupHint =
        "[Hyperfocus mode] Your identity and user profile are already loaded in the Narrative Story section. " +
        "Skip the session startup file reads (SOUL.md, USER.md, MEMORY.md) — those files are suppressed in this mode.";
      const goalLine = modeState.goal?.trim()
        ? `Current hyperfocus goal: ${modeState.goal.trim()}`
        : "";
      const extraPrompt = config.intensive?.extraSystemPrompt;
      const hyperfocusSystemPrompt = [startupHint, goalLine, extraPrompt]
        .filter(Boolean)
        .join("\n");
      return {
        narrativeStory: summaryContent ?? storyContent,
        extraSystemPrompt: hyperfocusSystemPrompt,
        suppressContextFiles: ["SOUL.md", "USER.md", "MEMORY.md", "IDENTITY.md"],
      };
    }

    const agents = await resolveNarrativeAgents();
    if (!agents) {
      return { narrativeStory: storyContent };
    }
    const { narrativeAgent, observerAgent } = agents;

    const sessionId = "global_user_memory";
    const skipResonance = process.env.MIND_SKIP_RESONANCE === "1";

    // Run memory pipeline in parallel:
    // [0] Bootstrap historical episodes into Graphiti (idempotent flag-file check)
    // [1] Sync global narrative from recent session files (fire-and-forget GLOSSARY.md + SUMMARY regen)
    // [2] Add current prompt as a graph episode
    // [3] Get flashback resonance for injection
    const [, , , flashbackResult] = await Promise.allSettled([
      config.graphiti?.enabled !== false
        ? (consolidator
            .bootstrapHistoricalEpisodes(
              sessionId,
              memoryDir,
              [],
              workspaceDir,
              resolveBootstrapChunkSize(api.config),
              sessionsDir,
              observerAgent,
              quickContext ?? undefined,
            )
            .catch((e) => process.stderr.write(`⚠️ [MIND] Bootstrap error: ${e}\n`)),
          Promise.resolve())
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
              Promise.all([
                consolidator
                  .generateGlossary(storyPath, glossaryPath, workspaceDir, narrativeAgent)
                  .catch(() => {}),
                consolidator
                  .generateSummary(storyPath, summaryPath, workspaceDir, narrativeAgent)
                  .catch(() => {}),
              ]),
            )
            .catch(() => {})
        : Promise.resolve(),
      config.graphiti?.enabled !== false
        ? (() => {
            // Batch episode ingestion: summarize every 8 messages instead of adding one per message.
            const fileKey = event.sessionFile ?? sessionId;
            const count = (sessionMessageCounters.get(fileKey) ?? 0) + 1;
            sessionMessageCounters.set(fileKey, count);
            if (count % 8 === 0) {
              // Build window of last 8 messages from recentMessages + current prompt
              const recent = ((event.recentMessages ?? []) as RecentMessage[]).slice(-7);
              const batchMsgs = [
                ...recent.map((m) => ({
                  role: m.role,
                  text: (typeof m.content === "string"
                    ? m.content
                    : Array.isArray(m.content)
                      ? (m.content as Array<{ type?: string; text?: string }>)
                          .filter((p) => p.type === "text")
                          .map((p) => p.text ?? "")
                          .join(" ")
                      : (m.text ?? "")
                  ).slice(0, 600),
                })),
                { role: "user", text: prompt.slice(0, 600) },
              ];
              return consolidator
                .summarizeConversationChunk(batchMsgs, observerAgent, quickContext ?? undefined)
                .then((episodeBody) =>
                  graphService.addEpisode(sessionId, episodeBody, event.timestamp),
                )
                .catch(() => {});
            }
            return Promise.resolve();
          })()
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
                  data: evt.data as Record<string, unknown>,
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

  // 5b. Register before_model_resolve hook: override model when intensive mode is active.
  // The session's stored model is naturally restored when intensive mode is deactivated —
  // no need to track "previous model" explicitly.
  const intensiveModelCfg = api.config.agents?.defaults?.intensiveModel;
  if (intensiveModelCfg) {
    const [intensiveProvider, intensiveModelId] = intensiveModelCfg.includes("/")
      ? (intensiveModelCfg.split("/", 2) as [string, string])
      : (["github-copilot", intensiveModelCfg] as [string, string]);

    api.on("before_model_resolve", async (_event, ctx) => {
      try {
        const agentId = ctx.agentId ?? resolveDefaultAgentId(api.config);
        const narrativeDir = resolveAgentNarrativeDir(api.config, agentId);
        const modeState = await readModeState(narrativeDir);
        if (modeState.mode === "intensive") {
          if (debug) {
            api.logger.info(
              `🎯 [MIND] intensive model override: ${intensiveProvider}/${intensiveModelId}`,
            );
          }
          return { providerOverride: intensiveProvider, modelOverride: intensiveModelId };
        }
      } catch {
        // Never block the run
      }
    });
  }

  // 6. Register before_compaction hook: sync STORY.md from the pre-compaction message history.
  // Fire-and-forget so it does not block the compaction LLM call.
  api.on("before_compaction", (event, _ctx) => {
    const { messages, sessionFile } = event;
    if (!messages || messages.length === 0 || config.narrative?.enabled === false) {
      return;
    }
    // Skip if the compaction safeguard will cancel (no real user/assistant messages)
    if (event.hasRealMessages === false) {
      return;
    }

    void (async () => {
      try {
        const agentId = resolveDefaultAgentId(api.config);
        const workspaceDir = resolveAgentWorkspaceDir(api.config, agentId);
        const narrativeDir = resolveAgentNarrativeDir(api.config, agentId);
        const storyPath = path.join(narrativeDir, "STORY.md");
        const glossaryPath = path.join(narrativeDir, "GLOSSARY.md");
        const summaryPath = path.join(narrativeDir, "SUMMARY.md");

        // Skip narrative updates during intensive/hyperfocus mode
        const modeState = await readModeState(narrativeDir);
        if (modeState.mode === "intensive") {
          if (debug) {
            api.logger.info(
              `🎯 [MIND] before_compaction: skipping narrative update (intensive mode)`,
            );
          }
          return;
        }

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

        sendNotify("🧠 Mind compacting session...");

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
                data: evt.data as Record<string, unknown>,
              });
            }
          },
        );

        sendNotify("✅ Mind compaction complete, regenerating profile...");

        // Fire-and-forget GLOSSARY.md + SUMMARY.md regeneration after story sync.
        void Promise.all([
          consolidator
            .generateGlossary(storyPath, glossaryPath, workspaceDir, narrativeAgent)
            .catch(() => {}),
          consolidator
            .generateSummary(storyPath, summaryPath, workspaceDir, narrativeAgent)
            .catch(() => {}),
        ]);

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
        const glossaryPath = path.join(narrativeDir, "GLOSSARY.md");
        const summaryPath = path.join(narrativeDir, "SUMMARY.md");

        // Skip narrative updates during intensive/hyperfocus mode
        const modeState = await readModeState(narrativeDir);
        if (modeState.mode === "intensive") {
          if (debug) {
            api.logger.info(
              `🎯 [MIND] after_compaction: skipping narrative update (intensive mode)`,
            );
          }
          return;
        }

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

        sendNotify("📖 Mind regenerating narrative...");

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
                data: evt.data as Record<string, unknown>,
              });
            }
          },
        );

        sendNotify("✅ Mind narrative updated, regenerating profile...");

        // Fire-and-forget GLOSSARY.md + SUMMARY.md regeneration after story sync.
        void Promise.all([
          consolidator
            .generateGlossary(storyPath, glossaryPath, workspaceDir, narrativeAgent)
            .catch(() => {}),
          consolidator
            .generateSummary(storyPath, summaryPath, workspaceDir, narrativeAgent)
            .catch(() => {}),
        ]);

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
  api.logger.info("  └─ Tool registered: activate_hyperfocus_mode / deactivate_hyperfocus_mode");
}
