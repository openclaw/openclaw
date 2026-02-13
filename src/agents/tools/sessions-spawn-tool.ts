import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import type { AnyAgentTool } from "./common.js";
import { formatThinkingLevels, normalizeThinkLevel } from "../../auto-reply/thinking.js";
import { loadConfig } from "../../config/config.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { bindSessionToThread, type ThreadBinding } from "../../config/thread-registry.js";
import { callGateway } from "../../gateway/call.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.js";
import { resolveAgentConfig } from "../agent-scope.js";
import { AGENT_LANE_SUBAGENT } from "../lanes.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { buildSubagentSystemPrompt } from "../subagent-announce.js";
import { registerSubagentRun } from "../subagent-registry.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./sessions-helpers.js";

/** Parameters for thread binding when spawning a child agent. */
type ThreadBindingSpawnParams = {
  mode: "bind" | "create";
  channel: string;
  accountId?: string;
  threadId?: string;
  to?: string;
  initialMessage?: string;
  deliveryMode?: "thread-only" | "thread+announcer" | "announcer-only";
  label?: string;
};

const ThreadBindingSchema = Type.Optional(
  Type.Object({
    mode: Type.Union([Type.Literal("bind"), Type.Literal("create")]),
    channel: Type.String(),
    accountId: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.String()),
    to: Type.Optional(Type.String()),
    initialMessage: Type.Optional(Type.String()),
    deliveryMode: Type.Optional(
      Type.Union([
        Type.Literal("thread-only"),
        Type.Literal("thread+announcer"),
        Type.Literal("announcer-only"),
      ]),
    ),
    label: Type.Optional(Type.String()),
  }),
);

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
  threadBinding: ThreadBindingSchema,
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

function normalizeModelSelection(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const primary = (value as { primary?: unknown }).primary;
  if (typeof primary === "string" && primary.trim()) {
    return primary.trim();
  }
  return undefined;
}

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
      if (typeof requesterSessionKey === "string" && isSubagentSessionKey(requesterSessionKey)) {
        return jsonResult({
          status: "forbidden",
          error: "sessions_spawn is not allowed from sub-agent sessions",
        });
      }
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
      const childSessionKey = `agent:${targetAgentId}:subagent:${crypto.randomUUID()}`;
      const spawnedByKey = requesterInternalKey;
      const targetAgentConfig = resolveAgentConfig(cfg, targetAgentId);
      const resolvedModel =
        normalizeModelSelection(modelOverride) ??
        normalizeModelSelection(targetAgentConfig?.subagents?.model) ??
        normalizeModelSelection(cfg.agents?.defaults?.subagents?.model);

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
      // -------------------------------------------------------------------
      // Thread binding (optional)
      // -------------------------------------------------------------------
      const threadBindingParams = params.threadBinding as ThreadBindingSpawnParams | undefined;
      let resolvedThreadBinding: ThreadBinding | undefined;

      if (threadBindingParams) {
        const deliveryMode = threadBindingParams.deliveryMode ?? "thread-only";

        if (threadBindingParams.mode === "bind") {
          // Bind to an existing thread
          if (!threadBindingParams.threadId) {
            return jsonResult({
              status: "error",
              error: 'threadBinding.threadId is required when mode is "bind"',
            });
          }
          resolvedThreadBinding = {
            channel: threadBindingParams.channel,
            accountId: threadBindingParams.accountId,
            to: threadBindingParams.to ?? opts?.agentTo,
            threadId: threadBindingParams.threadId,
            mode: deliveryMode,
            boundAt: Date.now(),
            createdBy: opts?.agentSessionKey,
            label: threadBindingParams.label,
          };
          if (!resolvedThreadBinding.to) {
            return jsonResult({
              status: "error",
              error:
                'threadBinding.to (channel/group ID) is required when mode is "bind" and cannot be inferred from context',
            });
          }
        } else if (threadBindingParams.mode === "create") {
          // Create a new thread by posting an initial message
          if (!threadBindingParams.to) {
            return jsonResult({
              status: "error",
              error: 'threadBinding.to (channel/group ID) is required when mode is "create"',
            });
          }
          const initialMessage =
            threadBindingParams.initialMessage ?? `🤖 Agent spawned: ${task.slice(0, 100)}`;

          // Use the channel plugin's threadOps to create the thread.
          const { loadChannelPlugin } = await import("../../channels/plugins/load.js");
          const plugin = await loadChannelPlugin(threadBindingParams.channel);
          if (!plugin?.threadOps?.createThread) {
            return jsonResult({
              status: "error",
              error: `Thread creation for channel "${threadBindingParams.channel}" is not supported. Use mode "bind" with an existing threadId.`,
            });
          }

          try {
            const result = await plugin.threadOps.createThread({
              to: threadBindingParams.to,
              accountId: threadBindingParams.accountId ?? undefined,
              initialMessage,
              cfg,
            });
            resolvedThreadBinding = {
              channel: threadBindingParams.channel,
              accountId: threadBindingParams.accountId,
              to: threadBindingParams.to,
              threadId: result.threadId,
              threadRootId: result.threadRootId,
              mode: deliveryMode,
              boundAt: Date.now(),
              createdBy: opts?.agentSessionKey,
              label: threadBindingParams.label,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return jsonResult({
              status: "error",
              error: `Failed to create thread: ${msg}`,
            });
          }
        }
      }

      // If a thread binding was established, override requester origin to route
      // the spawned agent's responses to the bound thread.
      const effectiveOrigin =
        resolvedThreadBinding && resolvedThreadBinding.mode !== "announcer-only"
          ? normalizeDeliveryContext({
              channel: resolvedThreadBinding.channel as GatewayMessageChannel,
              accountId: resolvedThreadBinding.accountId,
              to: requesterOrigin?.to ?? undefined,
              threadId: resolvedThreadBinding.threadId,
            })
          : requesterOrigin;

      const childSystemPrompt = buildSubagentSystemPrompt({
        requesterSessionKey,
        requesterOrigin: effectiveOrigin,
        childSessionKey,
        label: label || threadBindingParams?.label || undefined,
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
            channel: effectiveOrigin?.channel,
            to: effectiveOrigin?.to ?? undefined,
            accountId: effectiveOrigin?.accountId ?? undefined,
            threadId:
              effectiveOrigin?.threadId != null ? String(effectiveOrigin.threadId) : undefined,
            idempotencyKey: childIdem,
            deliver: false,
            lane: AGENT_LANE_SUBAGENT,
            extraSystemPrompt: childSystemPrompt,
            thinking: thinkingOverride,
            timeout: runTimeoutSeconds > 0 ? runTimeoutSeconds : undefined,
            label: label || threadBindingParams?.label || undefined,
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
        requesterOrigin: effectiveOrigin,
        requesterDisplayKey,
        task,
        cleanup,
        label: label || threadBindingParams?.label || undefined,
        runTimeoutSeconds,
      });

      // Persist the thread binding AFTER the agent session is created by callGateway.
      // This ensures the session entry already exists so mergeSessionEntry preserves
      // the threadBinding field (writing before callGateway would be overwritten).
      if (resolvedThreadBinding) {
        try {
          const storePath = resolveStorePath(undefined, { agentId: targetAgentId });
          await bindSessionToThread({
            storePath,
            sessionKey: childSessionKey,
            binding: resolvedThreadBinding,
          });
        } catch (err) {
          // Non-fatal: agent is already running, binding just won't auto-route
          const msg = err instanceof Error ? err.message : String(err);
          defaultRuntime.error?.(`Failed to persist thread binding (non-fatal): ${msg}`);
        }
      }

      return jsonResult({
        status: "accepted",
        childSessionKey,
        runId: childRunId,
        modelApplied: resolvedModel ? modelApplied : undefined,
        warning: modelWarning,
        threadBinding: resolvedThreadBinding
          ? {
              threadId: resolvedThreadBinding.threadId,
              channel: resolvedThreadBinding.channel,
              mode: resolvedThreadBinding.mode,
              label: resolvedThreadBinding.label,
            }
          : undefined,
      });
    },
  };
}
