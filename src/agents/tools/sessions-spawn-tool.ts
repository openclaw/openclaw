/**
 * sessions_spawn built-in tool.
 *
 * Starts subagent or ACP-backed sessions with inherited tool policy and delivery context.
 */
import { isAcpRuntimeSpawnAvailable } from "../../acp/runtime/availability.js";
import { supportsThreadBindingSpawn } from "../../channels/conversation-resolution.js";
import { resolveThreadBindingSpawnPolicy } from "../../channels/thread-bindings-policy.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSnakeCaseParamKey } from "../../param-key.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { createLazyPromise } from "../../shared/lazy-promise.js";
import {
  mergeAcceptedSessionSpawnsForRun,
  normalizeAcceptedSessionSpawnResult,
} from "../accepted-session-spawn.js";
import { captureAgentToolSourceExecutionGuard } from "../agent-tool-source-execution-guard.js";
import {
  findAcpUnsupportedInheritedToolAllow,
  findAcpUnsupportedInheritedToolDeny,
  formatAcpInheritedToolAllowError,
  formatAcpInheritedToolDenyError,
  resolveAcpInheritedToolPolicyError,
} from "../inherited-tool-deny.js";
import type { InheritedToolPolicySource } from "../inherited-tool-policy.schema.js";
import type { SpawnedToolContext } from "../spawned-context.js";
import { withParentExecutionIdentity } from "../subagents/spawn/execution-identity-spawn-context.js";
import { resolveAcpSessionsSpawnImageAttachments } from "../subagents/spawn/subagent-attachments.js";
import { spawnSubagentDirect } from "../subagents/spawn/subagent-spawn.js";
import { normalizeSubagentTaskName } from "../subagents/spawn/subagent-task-name.js";
import {
  SWARM_CODE_MODE_IDEMPOTENCY_KEY,
  SWARM_CODE_MODE_REQUEST_FINGERPRINT,
} from "../subagents/swarm/swarm-code-mode.js";
import {
  bindCollectorSpawnTool,
  captureCollectorSpawnGuard,
} from "../subagents/swarm/swarm-collector-capability.js";
import { resolveSwarmConfig } from "../subagents/swarm/swarm-config.js";
import {
  describeSessionsSpawnTool,
  SESSIONS_SPAWN_SUBAGENT_TOOL_DISPLAY_SUMMARY,
  SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import { withToolEffectBoundary } from "../tool-effect-receipt.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  normalizeToolModelOverride,
  readNonNegativeIntegerParam,
  readToolStringParam,
  ToolInputError,
} from "./common.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { runWithScopedSessionAccess } from "./scoped-session-access.js";
import {
  recordSessionToolActionFact,
  resolveEffectiveSessionToolsVisibility,
  resolveSandboxedSessionToolContext,
} from "./sessions-helpers.js";
import { createSessionsSpawnToolSchema } from "./sessions-spawn-tool.schema.js";
import {
  maybeSpawnVisibleSession,
  type VisibleSessionsSpawnDeps,
} from "./sessions-spawn-visible.js";

const UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS = [
  "target",
  "transport",
  "channel",
  "to",
  "threadId",
  "thread_id",
  "replyTo",
  "reply_to",
] as const;
const loadAcpSpawnModule = createLazyPromise(() => import("../subagents/spawn/acp-spawn.js"));

function addRoleToFailureResult<T extends { status: string }>(
  result: T,
  role: string | undefined,
): T | (T & { role: string }) {
  if (!role || (result.status !== "error" && result.status !== "forbidden")) {
    return result;
  }
  return { ...result, role };
}

function recordAcceptedSessionSpawn(
  result: Record<string, unknown>,
  context: "fork" | "isolated" | undefined,
): void {
  const instance = getGatewayToolCallerIdentity()?.operationalRunInstance;
  const accepted = normalizeAcceptedSessionSpawnResult({ details: result });
  if (instance && accepted) {
    mergeAcceptedSessionSpawnsForRun(instance, [accepted]);
  }
  const childSessionKey =
    typeof result.childSessionKey === "string" ? result.childSessionKey.trim() : "";
  const targetAgentId = childSessionKey
    ? parseAgentSessionKey(childSessionKey)?.agentId
    : undefined;
  if (result.status !== "accepted" || !childSessionKey || !targetAgentId || !context) {
    return;
  }
  recordSessionToolActionFact({
    operation: context === "fork" ? "fork" : "create",
    fact: "committed",
    targetAgentId,
    targetSessionKey: childSessionKey,
  });
}

type SessionsSpawnThreadAvailability = {
  subagent: boolean;
  acp: boolean;
};

function resolveSessionsSpawnThreadAvailability(opts?: {
  config?: OpenClawConfig;
  agentChannel?: string;
  agentAccountId?: string;
}): SessionsSpawnThreadAvailability {
  const channel = opts?.agentChannel;
  const cfg = opts?.config;
  if (!channel || !cfg || !supportsThreadBindingSpawn(channel)) {
    return { subagent: false, acp: false };
  }
  const resolve = (kind: "subagent" | "acp") => {
    const policy = resolveThreadBindingSpawnPolicy({
      cfg,
      channel,
      accountId: opts?.agentAccountId,
      kind,
    });
    return policy.enabled && policy.spawnEnabled;
  };
  return {
    subagent: resolve("subagent"),
    acp: resolve("acp"),
  };
}

function resolveAcpUnavailableMessage(opts?: { sandboxed?: boolean; config?: OpenClawConfig }) {
  if (opts?.sandboxed === true) {
    return 'runtime="acp" is unavailable from sandboxed sessions because ACP sessions run on the host. Use runtime="subagent".';
  }
  if (opts?.config?.acp?.enabled === false) {
    return 'runtime="acp" is unavailable because ACP is disabled by policy (`acp.enabled=false`). Use runtime="subagent".';
  }
  return 'runtime="acp" is unavailable in this session because no ACP runtime backend is loaded. Enable the acpx plugin or use runtime="subagent".';
}

export function createSessionsSpawnTool(
  opts?: {
    agentSessionKey?: string;
    requesterTurnRunId?: string;
    /** Separate key used only for completion routing (registerSubagentRun requesterSessionKey). */
    completionOwnerKey?: string;
    agentChannel?: string;
    agentAccountId?: string;
    agentTo?: string;
    agentThreadId?: string | number;
    currentMessagingTarget?: string;
    currentChannelId?: string;
    currentThreadTs?: string;
    currentMessageId?: string | number;
    sandboxed?: boolean;
    config?: OpenClawConfig;
    /** Explicit agent ID override for cron/hook sessions where session key parsing may not work. */
    requesterAgentIdOverride?: string;
    requesterRunId?: string;
    swarmCollector?: boolean;
    /** Backend-derived parent incarnation; never sourced from model arguments. */
    expectedParentSessionId?: string;
    signal?: AbortSignal;
  } & VisibleSessionsSpawnDeps &
    SpawnedToolContext,
): AnyAgentTool {
  const effectiveConfig = opts?.config ?? getRuntimeConfig();
  const acpAvailable = isAcpRuntimeSpawnAvailable({
    config: effectiveConfig,
    sandboxed: opts?.sandboxed,
  });
  const threadAvailability = resolveSessionsSpawnThreadAvailability({
    ...opts,
    config: effectiveConfig,
  });
  const threadAvailable = threadAvailability.subagent || (acpAvailable && threadAvailability.acp);
  const requesterAgentId =
    opts?.requesterAgentIdOverride ?? parseAgentSessionKey(opts?.agentSessionKey)?.agentId;
  const swarmConfig = resolveSwarmConfig(effectiveConfig, requesterAgentId);
  const sessionToolsVisibility = resolveEffectiveSessionToolsVisibility({
    cfg: effectiveConfig,
    sandboxed: opts?.sandboxed === true,
  });
  const { restrictToSpawned } = resolveSandboxedSessionToolContext({
    cfg: effectiveConfig,
    agentSessionKey: opts?.agentSessionKey,
    requesterAgentId,
    sandboxed: opts?.sandboxed,
  });
  const parameters = createSessionsSpawnToolSchema({
    acpAvailable,
    threadAvailable,
    subagentThreadAvailable: threadAvailability.subagent,
    swarmEnabled: swarmConfig.enabled,
  });
  const tool: AnyAgentTool = {
    label: "Sessions",
    name: "sessions_spawn",
    displaySummary: acpAvailable
      ? SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY
      : SESSIONS_SPAWN_SUBAGENT_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsSpawnTool({
      acpAvailable,
      threadAvailable,
      subagentThreadAvailable: threadAvailability.subagent,
      swarmEnabled: swarmConfig.enabled,
      sessionToolsVisibility,
      spawnRestricted: restrictToSpawned,
    }),
    parameters,
    execute: async (_toolCallId, args, signal) =>
      withToolEffectBoundary(async (onSpawnEffectsStart) => {
        const executionSignal =
          signal && opts?.signal
            ? AbortSignal.any([signal, opts.signal])
            : (signal ?? opts?.signal);
        const assertSourceActive = captureAgentToolSourceExecutionGuard(executionSignal);
        const params = args as Record<PropertyKey, unknown>;
        if (opts?.swarmCollector && params.collect !== true) {
          throw new ToolInputError(
            "sessions_spawn from a collector requires collect=true so approvals stay non-interactive.",
          );
        }
        const swarmParam = ["collect", "outputSchema", "fastMode", "groupId"].find((key) =>
          Object.hasOwn(params, key),
        );
        if (swarmParam && !swarmConfig.enabled) {
          throw new ToolInputError(
            `sessions_spawn parameter "${swarmParam}" requires tools.swarm.enabled=true.`,
          );
        }
        const hasCollectParam = Object.hasOwn(params, "collect");
        const collect = params.collect === true;
        const assertInvocationActive = collect
          ? captureCollectorSpawnGuard(tool, _toolCallId, assertSourceActive)
          : assertSourceActive;
        let acpSource: InheritedToolPolicySource | undefined;
        const assertActive = () => {
          assertInvocationActive();
          acpSource?.assertCurrent();
        };
        assertActive();
        if (
          getGatewayToolCallerIdentity()?.operationalRunInstance &&
          !opts?.captureInheritedToolPolicyForDelegation
        ) {
          return jsonResult({
            status: "forbidden",
            error: "Session spawn has no prepared source delegation policy.",
          });
        }
        if (params.outputSchema !== undefined && !collect) {
          throw new ToolInputError('sessions_spawn "outputSchema" requires collect=true.');
        }
        if (params.groupId !== undefined && !collect) {
          throw new ToolInputError('sessions_spawn "groupId" requires collect=true.');
        }
        if (
          collect &&
          (params.thread === true || params.visible === true || params.mode === "session")
        ) {
          throw new ToolInputError(
            "sessions_spawn collect=true does not support thread, visible, or session mode.",
          );
        }
        const unsupportedParam = UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS.find((key) =>
          Object.hasOwn(params, key),
        );
        if (unsupportedParam) {
          throw new ToolInputError(
            `sessions_spawn does not support "${unsupportedParam}"; remove channel-delivery parameters.`,
          );
        }
        const unsupportedTimeoutParam = resolveSnakeCaseParamKey(params, "timeoutSeconds");
        if (unsupportedTimeoutParam) {
          throw new ToolInputError(
            `sessions_spawn does not support "${unsupportedTimeoutParam}". Use "runTimeoutSeconds" for a per-run timeout.`,
          );
        }
        const task = readToolStringParam(params, "task", { required: true });
        const runTimeoutSeconds = readNonNegativeIntegerParam(params, "runTimeoutSeconds");
        const taskNameResult = normalizeSubagentTaskName(params.taskName);
        if (taskNameResult.error) {
          return jsonResult({
            status: "error",
            error: taskNameResult.error,
          });
        }
        const taskName = taskNameResult.taskName;
        const label = readToolStringParam(params, "label") ?? "";
        const runtime = params.runtime === "acp" ? "acp" : "subagent";
        const completionTarget = params.completionTarget;
        if (completionTarget !== undefined && completionTarget !== "parent") {
          throw new ToolInputError('sessions_spawn completionTarget must be "parent" or omitted.');
        }
        if (completionTarget === "parent" && (runtime === "acp" || params.visible === true)) {
          throw new ToolInputError(
            'sessions_spawn completionTarget="parent" requires a hidden native subagent run.',
          );
        }
        if (collect && runtime === "acp") {
          throw new ToolInputError('sessions_spawn collect=true supports runtime="subagent" only.');
        }
        const requestedAgentId = readToolStringParam(params, "agentId");
        const resumeSessionId = readToolStringParam(params, "resumeSessionId");
        const modelOverride = normalizeToolModelOverride(readToolStringParam(params, "model"));
        const thinkingOverrideRaw = readToolStringParam(params, "thinking");
        const cwd = readToolStringParam(params, "cwd");
        const mode = params.mode === "run" || params.mode === "session" ? params.mode : undefined;
        const cleanup =
          params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
        const expectsCompletionMessage = collect
          ? false
          : params.expectsCompletionMessage !== false;
        const sandbox = params.sandbox === "require" ? "require" : "inherit";
        const context =
          params.context === "fork" || params.context === "isolated" ? params.context : undefined;
        const streamTo = runtime === "acp" && params.streamTo === "parent" ? "parent" : undefined;
        const lightContext = params.lightContext === true;
        const roleContext = requestedAgentId ? { role: requestedAgentId } : {};
        const expectedParentSessionKey = opts?.agentSessionKey?.trim();
        if (opts?.expectedParentSessionId && !expectedParentSessionKey) {
          throw new Error("Exact parent session access requires a session key");
        }
        const spawnVisible = async () =>
          await maybeSpawnVisibleSession({
            raw: params,
            task,
            taskName,
            label,
            runtime,
            requestedAgentId,
            runTimeoutSeconds,
            sandbox,
            expectsCompletionMessage,
            options: {
              ...opts,
              onSpawnEffectsStart,
              assertActive,
              signal: executionSignal,
            },
          });
        const visibleResult = opts?.expectedParentSessionId
          ? await runWithScopedSessionAccess({
              cfg: effectiveConfig,
              expectedSessionId: opts.expectedParentSessionId,
              ...(opts.signal ? { signal: opts.signal } : {}),
              targetSessionKey: expectedParentSessionKey!,
              run: spawnVisible,
            })
          : await spawnVisible();
        if (visibleResult) {
          recordAcceptedSessionSpawn(visibleResult, context ?? "isolated");
          return jsonResult(
            addRoleToFailureResult(visibleResult as { status: string }, requestedAgentId),
          );
        }
        if (runtime === "acp" && opts?.captureInheritedToolPolicyForDelegation) {
          assertActive();
          acpSource = await opts.captureInheritedToolPolicyForDelegation();
          assertActive();
          const error = resolveAcpInheritedToolPolicyError(acpSource.policy);
          if (error) {
            return jsonResult({ status: "forbidden", error, ...roleContext });
          }
        }
        if (runtime === "acp" && !acpAvailable) {
          return jsonResult({
            status: "error",
            error: resolveAcpUnavailableMessage({
              config: effectiveConfig,
              sandboxed: opts?.sandboxed,
            }),
            ...roleContext,
          });
        }
        const acpUnsupportedInheritedTool =
          runtime === "acp" && !acpSource
            ? findAcpUnsupportedInheritedToolDeny(opts?.inheritedToolDenylist)
            : undefined;
        if (acpUnsupportedInheritedTool) {
          return jsonResult({
            status: "forbidden",
            error: formatAcpInheritedToolDenyError(acpUnsupportedInheritedTool),
            ...roleContext,
          });
        }
        const acpUnsupportedInheritedAllow =
          runtime === "acp" && !acpSource
            ? findAcpUnsupportedInheritedToolAllow(opts?.inheritedToolAllowlist)
            : undefined;
        if (acpUnsupportedInheritedAllow) {
          return jsonResult({
            status: "forbidden",
            error: formatAcpInheritedToolAllowError(acpUnsupportedInheritedAllow),
            ...roleContext,
          });
        }
        if (runtime === "acp" && lightContext) {
          throw new Error("lightContext is only supported for runtime='subagent'.");
        }
        if (runtime === "acp" && context === "fork") {
          throw new Error('context="fork" is only supported for runtime="subagent".');
        }
        const thread = params.thread === true;
        const attachments = Array.isArray(params.attachments)
          ? (params.attachments as Array<{
              name: string;
              content: string;
              encoding?: "utf8" | "base64";
              mimeType?: string;
            }>)
          : undefined;
        const parentExecutionIdentityToken = getGatewayToolCallerIdentity()?.executionIdentityToken;

        if (runtime === "acp") {
          const { spawnAcpDirect } = await loadAcpSpawnModule();
          const acpAttachments = resolveAcpSessionsSpawnImageAttachments({
            config: opts?.config ?? getRuntimeConfig(),
            attachments,
          });
          if (acpAttachments?.status === "forbidden" || acpAttachments?.status === "error") {
            return jsonResult({
              status: acpAttachments.status,
              error: acpAttachments.error,
              ...roleContext,
            });
          }
          const result = await spawnAcpDirect(
            {
              task,
              taskName,
              label: label || undefined,
              agentId: requestedAgentId,
              resumeSessionId,
              model: modelOverride,
              thinking: thinkingOverrideRaw,
              ...(runTimeoutSeconds !== undefined ? { runTimeoutSeconds } : {}),
              cwd,
              mode: mode === "run" || mode === "session" ? mode : undefined,
              thread,
              sandbox,
              cleanup,
              expectsCompletionMessage,
              streamTo,
              attachments: acpAttachments?.attachments,
            },
            withParentExecutionIdentity(
              {
                assertActive,
                onSpawnEffectsStart,
                agentSessionKey: opts?.agentSessionKey,
                requesterTurnRunId: opts?.requesterTurnRunId,
                completionOwnerKey: opts?.completionOwnerKey,
                requesterAgentIdOverride: opts?.requesterAgentIdOverride,
                agentChannel: opts?.agentChannel,
                agentAccountId: opts?.agentAccountId,
                agentTo: opts?.agentTo,
                agentThreadId: opts?.agentThreadId,
                currentMessagingTarget: opts?.currentMessagingTarget,
                currentChannelId: opts?.currentChannelId,
                currentMessageId: opts?.currentMessageId,
                agentGroupId: opts?.agentGroupId ?? undefined,
                agentGroupSpace: opts?.agentGroupSpace,
                agentMemberRoleIds: opts?.agentMemberRoleIds,
                sandboxed: opts?.sandboxed,
                inheritedToolPolicy: acpSource?.policy,
                inheritedToolAllowlist: opts?.inheritedToolAllowlist,
                inheritedToolDenylist: opts?.inheritedToolDenylist,
              },
              parentExecutionIdentityToken,
            ),
          );
          recordAcceptedSessionSpawn(result, "isolated");
          return jsonResult(addRoleToFailureResult(result, requestedAgentId));
        }

        const result = await spawnSubagentDirect(
          {
            task,
            taskName,
            label: label || undefined,
            agentId: requestedAgentId,
            model: modelOverride,
            thinking: thinkingOverrideRaw,
            ...(runTimeoutSeconds !== undefined ? { runTimeoutSeconds } : {}),
            collect: hasCollectParam ? collect : undefined,
            outputSchema:
              params.outputSchema && typeof params.outputSchema === "object"
                ? (params.outputSchema as Record<string, unknown>)
                : undefined,
            fastMode:
              params.fastMode === true || params.fastMode === false || params.fastMode === "auto"
                ? params.fastMode
                : undefined,
            groupId: readToolStringParam(params, "groupId"),
            swarmLaunchReplayKey:
              typeof params[SWARM_CODE_MODE_IDEMPOTENCY_KEY] === "string"
                ? params[SWARM_CODE_MODE_IDEMPOTENCY_KEY]
                : undefined,
            swarmLaunchRequestFingerprint:
              typeof params[SWARM_CODE_MODE_REQUEST_FINGERPRINT] === "string"
                ? params[SWARM_CODE_MODE_REQUEST_FINGERPRINT]
                : undefined,
            cwd,
            thread,
            mode,
            cleanup,
            sandbox,
            context,
            lightContext,
            expectsCompletionMessage,
            completionTarget,
            attachments,
            attachMountPath:
              params.attachAs && typeof params.attachAs === "object"
                ? readToolStringParam(params.attachAs as Record<string, unknown>, "mountPath")
                : undefined,
          },
          withParentExecutionIdentity(
            {
              agentSessionKey: opts?.agentSessionKey,
              requesterTurnRunId: opts?.requesterTurnRunId,
              requesterThinkingLevel: opts?.requesterThinkingLevel,
              requesterModel: opts?.requesterModel,
              completionOwnerKey: opts?.completionOwnerKey,
              agentChannel: opts?.agentChannel,
              agentAccountId: opts?.agentAccountId,
              agentTo: opts?.agentTo,
              agentThreadId: opts?.agentThreadId,
              currentMessagingTarget: opts?.currentMessagingTarget ?? opts?.currentChannelId,
              currentChannelId: opts?.currentChannelId,
              currentMessageId: opts?.currentMessageId,
              agentGroupId: opts?.agentGroupId,
              agentGroupChannel: opts?.agentGroupChannel,
              agentGroupSpace: opts?.agentGroupSpace,
              agentMemberRoleIds: opts?.agentMemberRoleIds,
              requesterAgentIdOverride: opts?.requesterAgentIdOverride,
              workspaceDir: opts?.workspaceDir,
              sessionPermissionPolicy: opts?.sessionPermissionPolicy,
              captureInheritedToolPolicyForDelegation: async () => {
                if (!opts?.captureInheritedToolPolicyForDelegation) {
                  throw new Error("Session spawn has no prepared source delegation policy.");
                }
                return await opts.captureInheritedToolPolicyForDelegation();
              },
              requesterRunId: opts?.requesterRunId,
              sandboxed: opts?.sandboxed,
              assertActive,
              onSpawnEffectsStart,
            },
            parentExecutionIdentityToken,
          ),
        );

        recordAcceptedSessionSpawn(result, result.context);
        return jsonResult(addRoleToFailureResult(result, requestedAgentId));
      }),
  };
  return bindCollectorSpawnTool(tool, parameters.properties, opts?.signal);
}
