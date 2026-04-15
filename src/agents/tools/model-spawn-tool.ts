import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { loadSessionStore, resolveStorePath, updateSessionStore } from "../../config/sessions.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import type { SpawnedToolContext } from "../spawned-context.js";
import { spawnSubagentDirect } from "../subagent-spawn.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

const MODEL_SPAWN_MODES = ["live", "spawn"] as const;

// Maximum concurrent spawns for multi-model parallel execution.
// Capped at 5 to stay within the default maxChildrenPerAgent limit.
// Note: countActiveRunsForSession is checked inside spawnSubagentDirect, so all
// concurrent spawns pass the gate before any sibling registers — proper enforcement
// requires a pre-flight batch-reservation API in the runtime.
const MAX_PARALLEL_SPAWNS = 5;

const SpawnEntrySchema = Type.Object({
  model: Type.String({
    description:
      'Full model spec for this spawn, e.g. "together/MiniMaxAI/MiniMax-M2.7". Required per-entry when no top-level model is set.',
  }),
  task: Type.Optional(
    Type.String({
      description: "Task for this spawn. Falls back to the top-level task when omitted.",
    }),
  ),
  label: Type.Optional(
    Type.String({
      description: "Human-readable label for this spawn's result.",
    }),
  ),
  context: Type.Optional(
    Type.String({
      description:
        "Context prepended to this spawn's task. Falls back to the top-level context when omitted.",
    }),
  ),
});

const ModelSpawnToolSchema = Type.Object({
  mode: stringEnum(MODEL_SPAWN_MODES, {
    description:
      "live=switch the current session model in-place (context preserved, takes effect next clean turn). spawn=run one or more tasks in isolated ephemeral sessions, each on a specified model (context isolated, sessions cleaned up by default).",
  }),
  model: Type.Optional(
    Type.String({
      description:
        'Model for live mode, or for a single-model spawn. Full provider/model spec, e.g. "together/MiniMaxAI/MiniMax-M2.7". Omit when using the spawns array.',
    }),
  ),
  task: Type.Optional(
    Type.String({
      description:
        "Task to run. Required for single-model spawn mode. Serves as the default task for entries in the spawns array that do not specify their own.",
    }),
  ),
  context: Type.Optional(
    Type.String({
      description:
        "Context to prepend to the task. Used for single-model spawn, or as default for spawns array entries.",
    }),
  ),
  spawns: Type.Optional(
    Type.Array(SpawnEntrySchema, {
      minItems: 1,
      maxItems: MAX_PARALLEL_SPAWNS,
      description:
        "Spawn multiple models concurrently, each in its own isolated session. All spawns run in parallel and results are collected. Use for model specialization (route different subtasks to the best model for each) or model comparison (run the same task across multiple models).",
    }),
  ),
  cleanup: optionalStringEnum(["delete", "keep"] as const, {
    description:
      'Session cleanup after spawn completes. Defaults to "delete" for ephemeral isolation.',
  }),
  timeout_seconds: Type.Optional(
    Type.Number({
      minimum: 0,
      description: "Timeout in seconds per spawn.",
    }),
  ),
});

export function createModelSpawnTool(
  opts?: {
    agentSessionKey?: string;
    agentChannel?: GatewayMessageChannel;
    agentAccountId?: string;
    agentTo?: string;
    agentThreadId?: string | number;
    /** Explicit agent ID override for cron/hook sessions where session key parsing may not work. */
    requesterAgentIdOverride?: string;
  } & SpawnedToolContext,
): AnyAgentTool {
  return {
    label: "Model Spawn",
    name: "model_spawn",
    description:
      'Spawn models for inference tasks. mode="live": switch the current session\'s model in-place (context preserved, takes effect next turn). mode="spawn": run one or more tasks in ephemeral isolated sessions — pass a single model+task for focused delegation, or a spawns[] array to run multiple models concurrently for specialization or comparison.',
    parameters: ModelSpawnToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const mode = params.mode === "live" || params.mode === "spawn" ? params.mode : undefined;
      if (!mode) {
        throw new ToolInputError('mode must be "live" or "spawn".');
      }

      // ── live mode ────────────────────────────────────────────────────────────
      if (mode === "live") {
        const modelRaw = readStringParam(params, "model", { required: true });
        if (!modelRaw?.trim()) {
          throw new ToolInputError("model is required for live mode.");
        }
        const model = modelRaw.trim();
        const slashIdx = model.indexOf("/");
        if (slashIdx < 1) {
          throw new ToolInputError(
            'model must include a provider prefix, e.g. "together/MiniMaxAI/MiniMax-M2.7".',
          );
        }
        const provider = model.slice(0, slashIdx);
        const modelId = model.slice(slashIdx + 1);
        if (!modelId) {
          throw new ToolInputError(
            'model must be in "provider/model-id" format, e.g. "together/MiniMaxAI/MiniMax-M2.7".',
          );
        }

        const sessionKey = opts?.agentSessionKey?.trim();
        if (!sessionKey) {
          return jsonResult({
            status: "error",
            error:
              "live mode requires an active named session. Cannot switch models outside a session context.",
          });
        }

        const cfg = loadConfig();
        // Prefer the explicit override (cron/hook contexts) before falling back to key parsing.
        const agentId =
          opts?.requesterAgentIdOverride?.trim() || resolveAgentIdFromSessionKey(sessionKey);
        const storePath = resolveStorePath(cfg.session?.store, { agentId });
        if (!storePath) {
          return jsonResult({
            status: "error",
            error: "Unable to resolve session store path for live model switch.",
          });
        }

        const store = loadSessionStore(storePath);
        const { mainKey, alias } = resolveMainSessionAlias(cfg);
        const internalKey = resolveInternalSessionKey({ key: sessionKey, alias, mainKey });
        const entry = store[internalKey];
        if (!entry) {
          return jsonResult({
            status: "error",
            error: `Session not found: ${sessionKey}. Cannot perform live model switch.`,
          });
        }

        const nextEntry = { ...entry };
        const { updated } = applyModelOverrideToSessionEntry({
          entry: nextEntry,
          selection: { provider, model: modelId, isDefault: false },
          selectionSource: "user",
          markLiveSwitchPending: true,
          // Preserve the existing auth profile override so an LLM-initiated model
          // switch does not silently clear a user-configured auth profile.
          profileOverride: entry.authProfileOverride,
          profileOverrideSource: entry.authProfileOverrideSource === "auto" ? "auto" : "user",
        });

        if (updated) {
          await updateSessionStore(storePath, (s) => {
            s[internalKey] = nextEntry;
          });
        }

        return jsonResult({
          status: "ok",
          mode: "live",
          model,
          provider,
          modelId,
          switchPending: updated,
          note: updated
            ? `Model switch to ${model} queued. Takes effect at the next clean turn boundary.`
            : `Model ${model} is already active for this session; no change was made.`,
        });
      }

      // ── spawn mode ───────────────────────────────────────────────────────────
      const rawSpawns = Array.isArray(params.spawns) ? params.spawns : undefined;
      const topModel = readStringParam(params, "model");
      const topTask = readStringParam(params, "task");
      const topContext = readStringParam(params, "context");
      const cleanup =
        params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "delete";
      const timeoutSeconds =
        typeof params.timeout_seconds === "number" && Number.isFinite(params.timeout_seconds)
          ? Math.max(0, Math.floor(params.timeout_seconds))
          : undefined;

      if (rawSpawns && rawSpawns.length > 0 && topModel?.trim()) {
        throw new ToolInputError(
          "Provide either a top-level model (single spawn) or a spawns array (multi-spawn), not both.",
        );
      }

      const spawnCtx = {
        agentSessionKey: opts?.agentSessionKey,
        agentChannel: opts?.agentChannel,
        agentAccountId: opts?.agentAccountId,
        agentTo: opts?.agentTo,
        agentThreadId: opts?.agentThreadId,
        agentGroupId: opts?.agentGroupId,
        agentGroupChannel: opts?.agentGroupChannel,
        agentGroupSpace: opts?.agentGroupSpace,
        requesterAgentIdOverride: opts?.requesterAgentIdOverride,
        workspaceDir: opts?.workspaceDir,
      } as const;

      // ── multi-model parallel spawn ───────────────────────────────────────────
      if (rawSpawns && rawSpawns.length > 0) {
        type SpawnEntry = { model?: unknown; task?: unknown; label?: unknown; context?: unknown };
        const entries = rawSpawns as SpawnEntry[];

        const spawnPromises = entries.map(async (entry, idx) => {
          const entryModel = typeof entry.model === "string" ? entry.model.trim() : "";
          const entryTask = (typeof entry.task === "string" ? entry.task : (topTask ?? "")).trim();
          const entryContext = (
            typeof entry.context === "string" ? entry.context : (topContext ?? "")
          ).trim();
          const entryLabel =
            typeof entry.label === "string" && entry.label.trim()
              ? entry.label.trim()
              : entryModel || `spawn[${idx}]`;

          if (!entryModel) {
            return { label: entryLabel, index: idx, status: "error", error: "model is required" };
          }
          if (!entryTask) {
            return {
              label: entryLabel,
              index: idx,
              status: "error",
              error: "task is required (provide per-entry or as top-level default)",
            };
          }

          const fullTask = entryContext ? `${entryContext}\n\n${entryTask}` : entryTask;
          try {
            const result = await spawnSubagentDirect(
              {
                task: fullTask,
                model: entryModel,
                cleanup,
                runTimeoutSeconds: timeoutSeconds,
                expectsCompletionMessage: true,
              },
              spawnCtx,
            );
            return { label: entryLabel, index: idx, model: entryModel, ...result };
          } catch (err) {
            return {
              label: entryLabel,
              index: idx,
              model: entryModel,
              status: "error" as const,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        });

        // Use allSettled so an unexpected rejection in any promise does not discard
        // results from already-completed spawns.
        const settled = await Promise.allSettled(spawnPromises);
        const results = settled.map((r) =>
          r.status === "fulfilled"
            ? r.value
            : { status: "error" as const, error: String(r.reason) },
        );
        return jsonResult({ mode: "spawn", multi: true, count: results.length, results });
      }

      // ── single-model spawn ───────────────────────────────────────────────────
      if (!topModel?.trim()) {
        throw new ToolInputError(
          "model is required for single spawn mode. Provide model for a single spawn or spawns[] for multi-model.",
        );
      }
      if (!topTask?.trim()) {
        throw new ToolInputError("task is required for spawn mode.");
      }

      const fullTask = topContext?.trim()
        ? `${topContext.trim()}\n\n${topTask.trim()}`
        : topTask.trim();

      const result = await spawnSubagentDirect(
        {
          task: fullTask,
          model: topModel.trim(),
          cleanup,
          runTimeoutSeconds: timeoutSeconds,
          expectsCompletionMessage: true,
        },
        spawnCtx,
      );

      return jsonResult({ mode: "spawn", multi: false, model: topModel.trim(), ...result });
    },
  };
}
