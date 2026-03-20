import crypto from "node:crypto";

import { Type } from "@sinclair/typebox";

import { formatThinkingLevels, normalizeThinkLevel } from "../../auto-reply/thinking.js";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { resolveAgentConfig } from "../agent-scope.js";
import { AGENT_LANE_SUBAGENT } from "../lanes.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { buildSubagentSystemPrompt } from "../subagent-announce.js";
import { registerSubagentRun } from "../subagent-registry.js";
import type { AnyAgentTool } from "./common.js";
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
  runtime: Type.Optional(Type.String({ enum: ["subagent", "acp"] })),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  // Back-compat alias. Prefer runTimeoutSeconds.
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  cwd: Type.Optional(Type.String()),
  resumeSessionId: Type.Optional(Type.String()),
  streamTo: Type.Optional(Type.String({ enum: ["parent"] })),
  thread: Type.Optional(Type.Boolean()),
  mode: Type.Optional(Type.String({ enum: ["run", "session"] })),
  sandbox: Type.Optional(Type.String({ enum: ["inherit", "require"] })),
  cleanup: optionalStringEnum(["delete", "keep"] as const),
});

function splitModelRef(ref?: string) {
  if (!ref) return { provider: undefined, model: undefined };
  const trimmed = ref.trim();
  if (!trimmed) return { provider: undefined, model: undefined };
  const [provider, model] = trimmed.split("/", 2);
  if (model) return { provider, model };
  return { provider: undefined, model: trimmed };
}

function normalizeModelSelection(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const primary = (value as { primary?: unknown }).primary;
  if (typeof primary === "string" && primary.trim()) return primary.trim();
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
      const runtime = params.runtime === "acp" ? "acp" : "subagent";
      const modelOverride = readStringParam(params, "model");
      const thinkingOverrideRaw = readStringParam(params, "thinking");
      const cwd = readStringParam(params, "cwd");
      const resumeSessionId = readStringParam(params, "resumeSessionId");
      const streamTo = params.streamTo === "parent" ? "parent" : undefined;
      const thread = typeof params.thread === "boolean" ? params.thread : false;
      const mode =
        params.mode === "session" || params.mode === "run"
          ? (params.mode as "session" | "run")
          : thread
            ? "session"
            : "run";
      const sandbox =
        params.sandbox === "require" || params.sandbox === "inherit"
          ? (params.sandbox as "require" | "inherit")
          : "inherit";
      const cleanup =
        params.cleanup === "keep" || params.cleanup === "delete"
          ? (params.cleanup as "keep" | "delete")
          : "keep";
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
        if (explicit !== undefined) return explicit;
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
      if (mode === "session" && !thread) {
        return jsonResult({
          status: "error",
          error: 'sessions_spawn mode="session" requires thread=true',
        });
      }
      if (runtime !== "acp" && streamTo) {
        return jsonResult({
          status: "error",
          error: 'sessions_spawn streamTo is only supported for runtime="acp"',
        });
      }
      if (runtime === "acp" && sandbox === "require") {
        return jsonResult({
          status: "error",
          error:
            'sessions_spawn sandbox="require" is unsupported for runtime="acp" because ACP sessions run outside the sandbox. Use runtime="subagent" or sandbox="inherit".',
        });
      }
      if (runtime === "acp" && opts?.sandboxed) {
        return jsonResult({
          status: "forbidden",
          error:
            'Sandboxed sessions cannot spawn ACP sessions because runtime="acp" runs on the host. Use runtime="subagent" from sandboxed sessions.',
        });
      }
      if (runtime !== "acp" && resumeSessionId) {
        return jsonResult({
          status: "error",
          error: 'sessions_spawn resumeSessionId requires runtime="acp"',
        });
      }
      const defaultAcpAgentId = cfg.acp ? readStringParam(cfg.acp, "defaultAgent") : undefined;
      const targetAgentId = requestedAgentId
        ? normalizeAgentId(requestedAgentId)
        : runtime === "acp"
          ? normalizeAgentId(defaultAcpAgentId)
          : requesterAgentId;
      if (!targetAgentId) {
        return jsonResult({
          status: "error",
          error:
            runtime === "acp"
              ? 'sessions_spawn runtime="acp" requires agentId unless acp.defaultAgent is configured'
              : "sessions_spawn target agent could not be resolved",
        });
      }
      if (runtime === "acp") {
        const allowedAgents = Array.isArray(cfg.acp?.allowedAgents) ? cfg.acp.allowedAgents : [];
        const allowSet = new Set(
          allowedAgents
            .filter((value) => typeof value === "string" && value.trim())
            .map((value) => normalizeAgentId(value).toLowerCase()),
        );
        if (allowSet.size > 0 && !allowSet.has(targetAgentId.toLowerCase())) {
          return jsonResult({
            status: "forbidden",
            error: `agentId is not allowed for ACP sessions_spawn (allowed: ${Array.from(allowSet).join(", ")})`,
          });
        }
      } else if (targetAgentId !== requesterAgentId) {
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
      const childSessionKey =
        runtime === "acp"
          ? `agent:${targetAgentId}:acp:${crypto.randomUUID()}`
          : `agent:${targetAgentId}:subagent:${crypto.randomUUID()}`;
      const spawnedByKey = requesterInternalKey;
      const targetAgentConfig = resolveAgentConfig(cfg, targetAgentId);
      const resolvedModel =
        normalizeModelSelection(modelOverride) ??
        normalizeModelSelection(targetAgentConfig?.subagents?.model) ??
        normalizeModelSelection(cfg.agents?.defaults?.subagents?.model);
      let thinkingOverride: string | undefined;
      if (thinkingOverrideRaw) {
        const normalized = normalizeThinkLevel(thinkingOverrideRaw);
        if (!normalized) {
          const { provider, model } = splitModelRef(resolvedModel);
          const hint = formatThinkingLevels(provider, model);
          return jsonResult({
            status: "error",
            error: `Invalid thinking level "${thinkingOverrideRaw}". Use one of: ${hint}.`,
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
      const childSystemPrompt =
        runtime === "subagent"
          ? buildSubagentSystemPrompt({
              requesterSessionKey,
              requesterOrigin,
              childSessionKey,
              label: label || undefined,
              task,
            })
          : undefined;

      const childIdem = crypto.randomUUID();
      let childRunId: string = childIdem;
      let acceptedMode: string | undefined;
      let acceptedNote: string | undefined;
      let acceptedStreamLogPath: string | undefined;
      try {
        const response = (await callGateway({
          method: "agent",
          params: {
            message: task,
            sessionKey: childSessionKey,
            channel: requesterOrigin?.channel,
            idempotencyKey: childIdem,
            deliver: false,
            lane: AGENT_LANE_SUBAGENT,
            runtime,
            mode,
            thread,
            cwd: cwd || undefined,
            model: resolvedModel,
            streamTo,
            resumeSessionId,
            sandbox,
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
        })) as { runId?: string; mode?: string; note?: string; streamLogPath?: string };
        if (typeof response?.runId === "string" && response.runId) {
          childRunId = response.runId;
        }
        if (typeof response?.mode === "string" && response.mode) {
          acceptedMode = response.mode;
        }
        if (typeof response?.note === "string" && response.note) {
          acceptedNote = response.note;
        }
        if (typeof response?.streamLogPath === "string" && response.streamLogPath) {
          acceptedStreamLogPath = response.streamLogPath;
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
        spawnMode: runtime === "acp" ? "acp" : "run",
        runtime,
        streamTo,
      });

      return jsonResult({
        status: "accepted",
        childSessionKey,
        runId: childRunId,
        mode: acceptedMode,
        note: acceptedNote,
        streamLogPath: acceptedStreamLogPath,
        modelApplied: resolvedModel ? modelApplied : undefined,
        warning: modelWarning,
      });
    },
  };
}
