import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import type { AnyAgentTool } from "./common.js";
import { formatThinkingLevels, normalizeThinkLevel } from "../../auto-reply/thinking.js";
import { resolveSubagentProviderLimit } from "../../config/agent-limits.js";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import {
  getSubagentDepth,
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.js";
import { listAgentIds, resolveAgentConfig } from "../agent-scope.js";
import { AGENT_LANE_SUBAGENT } from "../lanes.js";
import {
  resolveAllowRecursiveSpawn,
  resolveMaxChildrenPerAgent,
  resolveMaxSpawnDepth,
} from "../recursive-spawn-config.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { buildSubagentSystemPrompt } from "../subagent-announce.js";
import { resolveSpawnProvider } from "../subagent-provider-limits.js";
import {
  getActiveChildCount,
  getProviderUsage,
  registerSubagentRun,
  releaseChildSlot,
  releaseProviderSlot,
  reserveChildSlot,
  reserveProviderSlot,
} from "../subagent-registry.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./sessions-helpers.js";

const SessionsSpawnToolSchema = Type.Object({
  task: Type.String(),
  label: Type.Optional(Type.String()),
  agentId: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  // Back-compat alias. Prefer runTimeoutSeconds.
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  cleanup: optionalStringEnum(["delete", "keep"] as const),
});

function splitModelRef(ref?: string) {
  if (!ref) {
    return { provider: undefined, model: undefined };
  }
  const trimmed = ref.trim();
  if (!trimmed) {
    return { provider: undefined, model: undefined };
  }
  const [provider, model] = trimmed.split("/", 2);
  if (model) {
    return { provider, model };
  }
  return { provider: undefined, model: trimmed };
}

// Provider + model resolution for spawn limits lives in subagent-provider-limits.ts.

export function createSessionsSpawnTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  sandboxed?: boolean;
  /** Explicit agent ID override for cron/hook sessions where session key parsing may not work. */
  requesterAgentIdOverride?: string;
}): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_spawn",
    description:
      "Spawn a background sub-agent run in an isolated session and announce the result back to the requester chat.",
    parameters: SessionsSpawnToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const task = readStringParam(params, "task", { required: true });
      const label = typeof params.label === "string" ? params.label.trim() : "";
      const requestedAgentId = readStringParam(params, "agentId");
      const modelOverride = readStringParam(params, "model");
      const thinkingOverrideRaw = readStringParam(params, "thinking");
      const cleanup =
        params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
      const requesterOrigin = normalizeDeliveryContext({
        channel: opts?.agentChannel,
        accountId: opts?.agentAccountId,
        to: opts?.agentTo,
        threadId: opts?.agentThreadId,
      });
      const runTimeoutSeconds = (() => {
        const explicit =
          typeof params.runTimeoutSeconds === "number" && Number.isFinite(params.runTimeoutSeconds)
            ? Math.max(0, Math.floor(params.runTimeoutSeconds))
            : undefined;
        if (explicit !== undefined) {
          return explicit;
        }
        const legacy =
          typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds)
            ? Math.max(0, Math.floor(params.timeoutSeconds))
            : undefined;
        return legacy ?? 0;
      })();
      let modelWarning: string | undefined;
      let modelApplied = false;

      const cfg = loadConfig();
      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const requesterSessionKey = opts?.agentSessionKey;
      const requesterInternalKey = requesterSessionKey
        ? resolveInternalSessionKey({
            key: requesterSessionKey,
            alias,
            mainKey,
          })
        : alias;
      const requesterDisplayKey = resolveDisplaySessionKey({
        key: requesterInternalKey,
        alias,
        mainKey,
      });

      const requesterAgentId = normalizeAgentId(
        opts?.requesterAgentIdOverride ?? parseAgentSessionKey(requesterInternalKey)?.agentId,
      );
      const targetAgentId = requestedAgentId
        ? normalizeAgentId(requestedAgentId)
        : requesterAgentId;
      if (targetAgentId !== requesterAgentId) {
        const knownIds = new Set(listAgentIds(cfg).map((id) => normalizeAgentId(id)));
        if (!knownIds.has(normalizeAgentId(targetAgentId))) {
          return jsonResult({
            status: "error",
            error: `Unknown agent: "${targetAgentId}". Available: ${[...knownIds].join(", ")}`,
          });
        }
      }

      if (typeof requesterSessionKey === "string" && isSubagentSessionKey(requesterSessionKey)) {
        const currentDepth = getSubagentDepth(requesterSessionKey);
        const allowRecursive = resolveAllowRecursiveSpawn(cfg, requesterAgentId);
        const maxDepth = resolveMaxSpawnDepth(cfg, requesterAgentId);

        if (!allowRecursive) {
          return jsonResult({
            status: "forbidden",
            error:
              "Recursive spawning is not enabled. Set subagents.allowRecursiveSpawn: true in config.",
          });
        }

        if (currentDepth >= maxDepth) {
          return jsonResult({
            status: "forbidden",
            error: `Maximum subagent depth (${maxDepth}) reached. Cannot spawn deeper.`,
          });
        }
      }

      if (targetAgentId !== requesterAgentId) {
        const allowAgents = resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ?? [];
        const allowAny = allowAgents.some((value) => value.trim() === "*");
        const normalizedTargetId = targetAgentId.toLowerCase();
        const allowSet = new Set(
          allowAgents
            .filter((value) => value.trim() && value.trim() !== "*")
            .map((value) => normalizeAgentId(value).toLowerCase()),
        );
        if (!allowAny && !allowSet.has(normalizedTargetId)) {
          const allowedText = allowAny
            ? "*"
            : allowSet.size > 0
              ? Array.from(allowSet).join(", ")
              : "none";
          return jsonResult({
            status: "forbidden",
            error: `agentId is not allowed for sessions_spawn (allowed: ${allowedText})`,
          });
        }
      }
      const targetAgentConfig = resolveAgentConfig(cfg, targetAgentId);
      const { model: resolvedModel, provider: resolvedProvider } = resolveSpawnProvider({
        cfg,
        targetAgentId,
        modelOverride,
      });
      const spawnProvider = resolvedProvider ?? "unknown";
      const providerLimit = resolveSubagentProviderLimit(cfg, spawnProvider);

      const maxChildren = resolveMaxChildrenPerAgent(cfg, requesterAgentId);
      const reserved = reserveChildSlot(requesterInternalKey, maxChildren);
      if (!reserved) {
        const active = getActiveChildCount(requesterInternalKey);
        return jsonResult({
          status: "blocked",
          reason: "parent_limit",
          error: `Cannot spawn: ${active}/${maxChildren} children active. Wait for a child to complete.`,
        });
      }

      const providerReservation = reserveProviderSlot(spawnProvider, providerLimit);
      if (!providerReservation) {
        const usage = getProviderUsage(spawnProvider);
        releaseChildSlot(requesterInternalKey);
        return jsonResult({
          status: "blocked",
          reason: "provider_limit",
          provider: spawnProvider,
          active: usage.active,
          pending: usage.pending,
          used: usage.total,
          maxConcurrent: providerLimit,
          error: `Cannot spawn: provider ${spawnProvider} is at capacity (${usage.total}/${providerLimit}).`,
        });
      }

      let registeredRun = false;
      try {
        const childSessionKey =
          typeof requesterSessionKey === "string" && isSubagentSessionKey(requesterSessionKey)
            ? `${requesterSessionKey}:sub:${crypto.randomUUID()}`
            : `agent:${targetAgentId}:subagent:${crypto.randomUUID()}`;
        const parentDepth = getSubagentDepth(requesterInternalKey);
        const childDepth = parentDepth > 0 ? parentDepth + 1 : 1;
        const spawnedByKey = requesterInternalKey;

        const resolvedThinkingDefaultRaw =
          readStringParam(targetAgentConfig?.subagents ?? {}, "thinking") ??
          readStringParam(cfg.agents?.defaults?.subagents ?? {}, "thinking");

        let thinkingOverride: string | undefined;
        const thinkingCandidateRaw = thinkingOverrideRaw || resolvedThinkingDefaultRaw;
        if (thinkingCandidateRaw) {
          const normalized = normalizeThinkLevel(thinkingCandidateRaw);
          if (!normalized) {
            const { provider, model } = splitModelRef(resolvedModel);
            const hint = formatThinkingLevels(provider, model);
            return jsonResult({
              status: "error",
              error: `Invalid thinking level "${thinkingCandidateRaw}". Use one of: ${hint}.`,
            });
          }
          thinkingOverride = normalized;
        }
        if (resolvedModel) {
          try {
            await callGateway({
              method: "sessions.patch",
              params: { key: childSessionKey, model: resolvedModel },
              timeoutMs: 10_000,
            });
            modelApplied = true;
          } catch (err) {
            const messageText =
              err instanceof Error ? err.message : typeof err === "string" ? err : "error";
            const recoverable =
              messageText.includes("invalid model") || messageText.includes("model not allowed");
            if (!recoverable) {
              return jsonResult({
                status: "error",
                error: messageText,
                childSessionKey,
              });
            }
            modelWarning = messageText;
          }
        }
        if (thinkingOverride !== undefined) {
          try {
            await callGateway({
              method: "sessions.patch",
              params: {
                key: childSessionKey,
                thinkingLevel: thinkingOverride === "off" ? null : thinkingOverride,
              },
              timeoutMs: 10_000,
            });
          } catch (err) {
            const messageText =
              err instanceof Error ? err.message : typeof err === "string" ? err : "error";
            return jsonResult({
              status: "error",
              error: messageText,
              childSessionKey,
            });
          }
        }
        const childSystemPrompt = buildSubagentSystemPrompt({
          requesterSessionKey,
          requesterOrigin,
          childSessionKey,
          label: label || undefined,
          task,
        });

        const childIdem = crypto.randomUUID();
        let childRunId: string = childIdem;
        try {
          const response = await callGateway<{ runId: string }>({
            method: "agent",
            params: {
              message: task,
              sessionKey: childSessionKey,
              channel: requesterOrigin?.channel,
              to: requesterOrigin?.to ?? undefined,
              accountId: requesterOrigin?.accountId ?? undefined,
              threadId:
                requesterOrigin?.threadId != null ? String(requesterOrigin.threadId) : undefined,
              idempotencyKey: childIdem,
              deliver: false,
              lane: AGENT_LANE_SUBAGENT,
              extraSystemPrompt: childSystemPrompt,
              thinking: thinkingOverride,
              timeout: runTimeoutSeconds > 0 ? runTimeoutSeconds : undefined,
              label: label || undefined,
              spawnedBy: spawnedByKey,
              groupId: opts?.agentGroupId ?? undefined,
              groupChannel: opts?.agentGroupChannel ?? undefined,
              groupSpace: opts?.agentGroupSpace ?? undefined,
            },
            timeoutMs: 10_000,
          });
          if (typeof response?.runId === "string" && response.runId) {
            childRunId = response.runId;
          }
        } catch (err) {
          const messageText =
            err instanceof Error ? err.message : typeof err === "string" ? err : "error";
          return jsonResult({
            status: "error",
            error: messageText,
            childSessionKey,
            runId: childRunId,
          });
        }

        registerSubagentRun({
          runId: childRunId,
          childSessionKey,
          requesterSessionKey: requesterInternalKey,
          requesterOrigin,
          requesterDisplayKey,
          task,
          cleanup,
          label: label || undefined,
          runTimeoutSeconds,
          depth: childDepth,
          provider: spawnProvider,
          providerReservation,
        });
        registeredRun = true;

        return jsonResult({
          status: "accepted",
          childSessionKey,
          runId: childRunId,
          modelApplied: resolvedModel ? modelApplied : undefined,
          warning: modelWarning,
        });
      } finally {
        if (!registeredRun) {
          releaseChildSlot(requesterInternalKey);
          releaseProviderSlot(providerReservation);
        }
      }
    },
  };
}
