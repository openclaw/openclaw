import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import type { AnyAgentTool } from "./common.js";
import { formatThinkingLevels, normalizeThinkLevel } from "../../auto-reply/thinking.js";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.js";
import { resolveAgentConfig } from "../agent-scope.js";
import { AGENT_LANE_SUBAGENT } from "../lanes.js";
import { resolveDefaultModelForAgent } from "../model-selection.js";
import {
  buildHandoffEnvelope,
  buildHandoffFingerprint,
  formatTaskForSubagent,
  resolveOrchestrationConfig,
  type OrchestrationArtifact,
  type OrchestrationPriority,
  type OrchestrationReturnFormat,
  type OrchestrationTaskType,
} from "../orchestration.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { buildSubagentSystemPrompt } from "../subagent-announce.js";
import { getSubagentDepthFromSessionStore } from "../subagent-depth.js";
import {
  countActiveRunsForSession,
  hasActiveEquivalentHandoff,
  registerSubagentRun,
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
  cleanup: optionalStringEnum(["delete", "keep"] as const),
  objective: Type.Optional(Type.String()),
  taskType: Type.Optional(
    Type.Union([
      Type.Literal("analysis"),
      Type.Literal("draft"),
      Type.Literal("critique"),
      Type.Literal("plan"),
      Type.Literal("estimate"),
      Type.Literal("review"),
    ]),
  ),
  requestedOutput: Type.Optional(Type.String()),
  constraints: Type.Optional(Type.Array(Type.String())),
  knownFacts: Type.Optional(Type.Array(Type.String())),
  relevantArtifacts: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.Optional(Type.String()),
        path: Type.Optional(Type.String()),
        url: Type.Optional(Type.String()),
        env: Type.Optional(Type.String()),
        fileName: Type.Optional(Type.String()),
        errorSnippet: Type.Optional(Type.String()),
        note: Type.Optional(Type.String()),
      }),
    ),
  ),
  priority: Type.Optional(
    Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high")]),
  ),
  returnFormat: Type.Optional(
    Type.Union([
      Type.Literal("bullets"),
      Type.Literal("draft"),
      Type.Literal("json-like structured text"),
      Type.Literal("decision memo"),
    ]),
  ),
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
      // Default to 0 (no timeout) when omitted. Sub-agent runs are long-lived
      // by default and should not inherit the main agent 600s timeout.
      const runTimeoutSeconds =
        typeof params.runTimeoutSeconds === "number" && Number.isFinite(params.runTimeoutSeconds)
          ? Math.max(0, Math.floor(params.runTimeoutSeconds))
          : 0;
      let modelWarning: string | undefined;
      let modelApplied = false;

      const cfg = loadConfig();
      const orchestration = resolveOrchestrationConfig(cfg);
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

      const callerDepth = getSubagentDepthFromSessionStore(requesterInternalKey, { cfg });
      const maxSpawnDepth = cfg.agents?.defaults?.subagents?.maxSpawnDepth ?? 1;
      if (callerDepth >= maxSpawnDepth) {
        return jsonResult({
          status: "forbidden",
          error: `sessions_spawn is not allowed at this depth (current depth: ${callerDepth}, max: ${maxSpawnDepth})`,
        });
      }

      const maxChildren = cfg.agents?.defaults?.subagents?.maxChildrenPerAgent ?? 5;
      const maxAgentsPerRequest = orchestration.limits.maxAgentsPerRequest;
      const effectiveMaxChildren = Math.min(maxChildren, maxAgentsPerRequest);
      const activeChildren = countActiveRunsForSession(requesterInternalKey);
      if (activeChildren >= effectiveMaxChildren) {
        return jsonResult({
          status: "forbidden",
          error: `sessions_spawn has reached max active children for this session (${activeChildren}/${effectiveMaxChildren})`,
        });
      }

      const requesterAgentId = normalizeAgentId(
        opts?.requesterAgentIdOverride ?? parseAgentSessionKey(requesterInternalKey)?.agentId,
      );
      const defaultAgentId = normalizeAgentId(parseAgentSessionKey(mainKey)?.agentId ?? "main");
      const targetAgentId = requestedAgentId
        ? normalizeAgentId(requestedAgentId)
        : requesterAgentId;
      if (
        requesterAgentId !== defaultAgentId &&
        targetAgentId !== requesterAgentId &&
        !orchestration.communication.allowDirectSpecialistToSpecialist
      ) {
        return jsonResult({
          status: "forbidden",
          error:
            "direct specialist-to-specialist delegation is disabled; route follow-up work back through Main",
        });
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
      const childSessionKey = `agent:${targetAgentId}:subagent:${crypto.randomUUID()}`;
      const childDepth = callerDepth + 1;
      const spawnedByKey = requesterInternalKey;
      const handoffEnvelope = buildHandoffEnvelope({
        targetAgent: targetAgentId,
        objective: readStringParam(params, "objective"),
        taskText: task,
        taskType:
          (readStringParam(params, "taskType") as OrchestrationTaskType | undefined) ?? undefined,
        requestedOutput: readStringParam(params, "requestedOutput"),
        constraints: Array.isArray(params.constraints)
          ? params.constraints.filter((value): value is string => typeof value === "string")
          : undefined,
        knownFacts: Array.isArray(params.knownFacts)
          ? params.knownFacts.filter((value): value is string => typeof value === "string")
          : undefined,
        relevantArtifacts: Array.isArray(params.relevantArtifacts)
          ? params.relevantArtifacts.filter(
              (value): value is OrchestrationArtifact =>
                typeof value === "object" && value !== null,
            )
          : undefined,
        priority:
          (readStringParam(params, "priority") as OrchestrationPriority | undefined) ?? undefined,
        returnFormat:
          (readStringParam(params, "returnFormat") as OrchestrationReturnFormat | undefined) ??
          undefined,
      });
      const handoffFingerprint = buildHandoffFingerprint(handoffEnvelope);
      if (
        orchestration.limits.dedupeRepeatedHandoffs &&
        hasActiveEquivalentHandoff({
          requesterSessionKey: requesterInternalKey,
          handoffFingerprint,
        })
      ) {
        return jsonResult({
          status: "forbidden",
          error: "duplicate active handoff blocked because no new information was added",
        });
      }
      const targetAgentConfig = resolveAgentConfig(cfg, targetAgentId);
      const runtimeDefaultModel = resolveDefaultModelForAgent({
        cfg,
        agentId: targetAgentId,
      });
      const resolvedModel =
        normalizeModelSelection(modelOverride) ??
        normalizeModelSelection(targetAgentConfig?.subagents?.model) ??
        normalizeModelSelection(cfg.agents?.defaults?.subagents?.model) ??
        normalizeModelSelection(cfg.agents?.defaults?.model?.primary) ??
        normalizeModelSelection(`${runtimeDefaultModel.provider}/${runtimeDefaultModel.model}`);

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
      try {
        await callGateway({
          method: "sessions.patch",
          params: { key: childSessionKey, spawnDepth: childDepth },
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
      const childTask = formatTaskForSubagent({
        envelope: handoffEnvelope,
        rawTaskText: task,
        includeEnvelope: orchestration.communication.requireStructuredHandoff,
      });
      const childSystemPrompt = buildSubagentSystemPrompt({
        requesterSessionKey,
        requesterOrigin,
        childSessionKey,
        label: label || undefined,
        task: childTask,
        childDepth,
        maxSpawnDepth: Math.min(maxSpawnDepth, orchestration.limits.maxDelegationDepth),
      });

      const childIdem = crypto.randomUUID();
      let childRunId: string = childIdem;
      try {
        const response = await callGateway<{ runId: string }>({
          method: "agent",
          params: {
            message: childTask,
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
            timeout: runTimeoutSeconds,
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
        task: childTask,
        targetAgentId,
        handoffFingerprint,
        cleanup,
        label: label || undefined,
        model: resolvedModel,
        runTimeoutSeconds,
      });

      return jsonResult({
        status: "accepted",
        childSessionKey,
        runId: childRunId,
        modelApplied: resolvedModel ? modelApplied : undefined,
        warning: modelWarning,
      });
    },
  };
}
