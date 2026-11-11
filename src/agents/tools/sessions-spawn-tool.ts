import { isAcpRuntimeSpawnAvailable } from "../../acp/runtime/availability.js";
import { getRuntimeConfig } from "../../config/config.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import {
  captureExecRequestOwners,
  withExecRequestOwners,
} from "../../infra/exec-request-context.js";
import { resolveSnakeCaseParamKey } from "../../param-key.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
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
} from "../inherited-tool-deny.js";
import { resolveSenderRestrictedSpawnError } from "../spawn-requester-policy.js";
import { withParentExecutionIdentity } from "../subagents/spawn/execution-identity-spawn-context.js";
import { resolveAcpSessionsSpawnImageAttachments } from "../subagents/spawn/subagent-attachments.js";
import type { SpawnSubagentParams } from "../subagents/spawn/subagent-spawn-contract.js";
import { normalizeSubagentTaskName } from "../subagents/spawn/subagent-task-name.js";
import {
  SWARM_CODE_MODE_IDEMPOTENCY_KEY,
  SWARM_CODE_MODE_REQUEST_FINGERPRINT,
} from "../subagents/swarm/swarm-code-mode.js";
import {
  bindCollectorSpawnTool,
  captureCollectorSpawnGuard,
  captureCollectorPluginContext,
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
import {
  getGatewayToolCallerIdentity,
  resolveGatewayToolOperatorSelection,
  wrapGatewayPersonalToolExecution,
} from "./gateway-caller-context.js";
import { runWithScopedSessionAccess } from "./scoped-session-access.js";
import {
  recordSessionToolActionFact,
  resolveEffectiveSessionToolsVisibility,
  resolveSandboxedSessionToolContext,
} from "./sessions-helpers.js";
import {
  PlacedSessionsSpawnSchema,
  PLACED_SESSIONS_SPAWN_DESCRIPTION,
} from "./sessions-placement-tool-contract.js";
import { readSessionsSpawnCyberAccessProgram } from "./sessions-spawn-access-program.js";
import { resolveSessionsSpawnAcpUnavailableMessage } from "./sessions-spawn-acp-availability.js";
import { describeSessionsSpawnAgentId } from "./sessions-spawn-agent-id.js";
import type { SessionsSpawnToolOptions } from "./sessions-spawn-options.js";
import { resolveSessionsSpawnThreadAvailability } from "./sessions-spawn-thread-availability.js";
import { createSessionsSpawnToolSchema } from "./sessions-spawn-tool.schema.js";

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
// Tool discovery needs schemas, not the runtimes that create child sessions.
const loadSubagentSpawnModule = createLazyPromise(
  () => import("../subagents/spawn/subagent-spawn.js"),
);
const loadVisibleSpawnModule = createLazyPromise(() => import("./sessions-spawn-visible.js"));

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

export function createSessionsSpawnTool(
  opts?: SessionsSpawnToolOptions & { workerPlacement?: boolean },
): AnyAgentTool {
  const requesterThinkingExplicit =
    // SAFETY: The host forwards this optional runtime bit; public callers can omit it.
    (opts as (typeof opts & { requesterThinkingExplicit?: boolean }) | undefined)
      ?.requesterThinkingExplicit;
  const requestOwners = captureExecRequestOwners({
    runId: opts?.requesterTurnRunId,
    sessionId: opts?.expectedParentSessionId,
  });
  const effectiveConfig = opts?.config ?? getRuntimeConfig();
  const acpAvailable = isAcpRuntimeSpawnAvailable({
    config: effectiveConfig,
    sandboxed: opts?.sandboxed,
  });
  const threadAvailability = resolveSessionsSpawnThreadAvailability({
    ...opts,
    config: effectiveConfig,
  });
  const threadAvailable = threadAvailability.subagent || threadAvailability.acp;
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
  const agentIdGuidance = describeSessionsSpawnAgentId({
    cfg: effectiveConfig,
    requesterAgentId,
    requesterIsSubagent: opts?.requesterIsSubagent ?? isSubagentSessionKey(opts?.agentSessionKey),
    acpAvailable,
    collectDefaultAgentId: swarmConfig.enabled ? swarmConfig.defaultAgentId : undefined,
    spawnContext: opts,
  });
  const parameters = opts?.workerPlacement
    ? PlacedSessionsSpawnSchema
    : createSessionsSpawnToolSchema({
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
    description: opts?.workerPlacement
      ? PLACED_SESSIONS_SPAWN_DESCRIPTION
      : describeSessionsSpawnTool({
          acpAvailable,
          threadAvailable,
          subagentThreadAvailable: threadAvailability.subagent,
          swarmEnabled: swarmConfig.enabled,
          sessionToolsVisibility,
          spawnRestricted: restrictToSpawned,
          agentIdGuidance,
        }),
    parameters,
    execute: wrapGatewayPersonalToolExecution(async (_toolCallId, args, signal) =>
      withToolEffectBoundary(async (onSpawnEffectsStart) => {
        const operatorSelection = resolveGatewayToolOperatorSelection();
        const executionSignal =
          signal && opts?.signal
            ? AbortSignal.any([signal, opts.signal])
            : (signal ?? opts?.signal);
        const assertSourceExecution = captureAgentToolSourceExecutionGuard(executionSignal);
        const assertSourceActive = composeSessionSourceAssertion([
          assertSourceExecution,
          operatorSelection.assertCurrent,
        ]);
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
        const assertActive = collect
          ? captureCollectorSpawnGuard(tool, _toolCallId, assertSourceActive)
          : assertSourceActive;
        assertActive();
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
        const task =
          readToolStringParam(params, "task", {
            required: !opts?.independent,
            trim: !opts?.independent,
          }) ?? "";
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
        if (runtime === "subagent" && opts?.delegatedToolPolicyUnavailable) {
          throw new ToolInputError(
            "This mediated tool surface cannot preserve the active delegated execution grant. Start the helper from a Gateway-side native tool surface.",
          );
        }
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
        if (params.blind === true && (runtime === "acp" || params.visible === true)) {
          throw new ToolInputError('blind=true requires a hidden runtime="subagent" child.');
        }
        const requestedAgentId = readToolStringParam(params, "agentId");
        const requesterPolicyError = resolveSenderRestrictedSpawnError({
          inheritedToolPolicySource: opts?.inheritedToolPolicySource,
          requesterAgentId,
          targetAgentId: requestedAgentId ? normalizeAgentId(requestedAgentId) : undefined,
          visible: params.visible === true,
        });
        if (requesterPolicyError) {
          return jsonResult({ status: "forbidden", error: requesterPolicyError });
        }
        const resumeSessionId = readToolStringParam(params, "resumeSessionId");
        const modelOverride = normalizeToolModelOverride(readToolStringParam(params, "model"));
        const thinkingOverrideRaw = readToolStringParam(params, "thinking");
        const cyberAccessProgram = readSessionsSpawnCyberAccessProgram(params, runtime);
        const cwd = readToolStringParam(params, "cwd");
        const mode = params.mode === "run" || params.mode === "session" ? params.mode : undefined;
        const cleanup = params.cleanup === "delete" ? "delete" : "keep";
        const expectsCompletionMessage = !collect && params.expectsCompletionMessage !== false;
        const sandbox = params.sandbox === "require" ? "require" : "inherit";
        const context =
          params.context === "fork" || params.context === "isolated" ? params.context : undefined;
        const streamTo = runtime === "acp" && params.streamTo === "parent" ? "parent" : undefined;
        const lightContext = params.lightContext === true;
        const spawnResult = <T extends { status: string }>(result: T) =>
          jsonResult(
            requestedAgentId && (result.status === "error" || result.status === "forbidden")
              ? { ...result, role: requestedAgentId }
              : result,
          );
        const expectedParentSessionKey = opts?.agentSessionKey?.trim();
        if (opts?.expectedParentSessionId && !expectedParentSessionKey) {
          throw new Error("Exact parent session access requires a session key");
        }
        const spawnVisible = async () => {
          const { maybeSpawnVisibleSession } = await loadVisibleSpawnModule();
          // Imports are shared; the original invocation must still own this call.
          assertActive();
          return maybeSpawnVisibleSession({
            raw: params,
            task,
            taskName,
            label,
            runtime,
            requestedAgentId,
            runTimeoutSeconds,
            sandbox,
            expectsCompletionMessage,
            cyberAccessProgram,
            options: withExecRequestOwners(
              {
                ...opts,
                onSpawnEffectsStart,
                assertActive,
                signal: executionSignal,
              },
              requestOwners,
            ),
          });
        };
        const visibleResult =
          params.visible === true && opts?.expectedParentSessionId
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
          return spawnResult(visibleResult as { status: string });
        }
        if (runtime === "acp" && !acpAvailable) {
          return spawnResult({
            status: "error",
            error: resolveSessionsSpawnAcpUnavailableMessage({
              config: effectiveConfig,
              sandboxed: opts?.sandboxed,
            }),
          });
        }
        const acpUnsupportedInheritedTool =
          runtime === "acp"
            ? findAcpUnsupportedInheritedToolDeny(opts?.inheritedToolDenylist)
            : undefined;
        if (acpUnsupportedInheritedTool) {
          return spawnResult({
            status: "forbidden",
            error: formatAcpInheritedToolDenyError(acpUnsupportedInheritedTool),
          });
        }
        const acpUnsupportedInheritedAllow =
          runtime === "acp"
            ? findAcpUnsupportedInheritedToolAllow(opts?.inheritedToolAllowlist)
            : undefined;
        if (acpUnsupportedInheritedAllow) {
          return spawnResult({
            status: "forbidden",
            error: formatAcpInheritedToolAllowError(acpUnsupportedInheritedAllow),
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
          ? (params.attachments as SpawnSubagentParams["attachments"])
          : undefined;
        const parentExecutionIdentityToken = getGatewayToolCallerIdentity()?.executionIdentityToken;
        const spawnParams = {
          task,
          taskName,
          label: label || undefined,
          agentId: requestedAgentId,
          model: modelOverride,
          thinking: thinkingOverrideRaw,
          ...(runTimeoutSeconds !== undefined ? { runTimeoutSeconds } : {}),
          cwd,
          mode,
          thread,
          sandbox,
          cleanup,
          expectsCompletionMessage,
        } as const;
        const inheritedSpawnContext = () => ({
          assertActive,
          onSpawnEffectsStart,
          agentSessionKey: opts?.agentSessionKey,
          senderIsOwner: opts?.senderIsOwner,
          gitContributorProfileId: opts?.gitContributorProfileId,
          expectedParentSessionId: opts?.expectedParentSessionId,
          requesterTurnRunId: opts?.requesterTurnRunId,
          completionOwnerKey: opts?.completionOwnerKey,
          requesterAgentIdOverride: opts?.requesterAgentIdOverride,
          agentChannel: opts?.agentChannel,
          agentAccountId: opts?.agentAccountId,
          agentTo: opts?.agentTo,
          agentThreadId: opts?.agentThreadId,
          currentChannelId: opts?.currentChannelId,
          currentThreadTs: opts?.currentThreadTs,
          currentConversationOrigin: opts?.currentConversationOrigin,
          currentMessageId: opts?.currentMessageId,
          agentGroupSpace: opts?.agentGroupSpace,
          agentMemberRoleIds: opts?.agentMemberRoleIds,
          sandboxed: opts?.sandboxed,
          inheritedToolAllowlist: opts?.inheritedToolAllowlist,
          inheritedToolDenylist: opts?.inheritedToolDenylist,
          ...(runtime === "subagent"
            ? {
                delegatedToolDenyFloor: opts?.delegatedToolDenyFloor,
                requesterToolDenylist: opts?.requesterToolDenylist,
                readDelegationConfig: opts?.readDelegationConfig,
              }
            : {}),
          inheritedToolPolicySource: opts?.inheritedToolPolicySource,
          workspaceDir: opts?.workspaceDir,
          sessionPermissionPolicy: opts?.sessionPermissionPolicy,
        });

        if (runtime === "acp") {
          const { spawnAcpDirect } = await loadAcpSpawnModule();
          const acpAttachments = resolveAcpSessionsSpawnImageAttachments({
            config: opts?.config ?? getRuntimeConfig(),
            attachments,
          });
          if (acpAttachments?.status === "forbidden" || acpAttachments?.status === "error") {
            return spawnResult({
              status: acpAttachments.status,
              error: acpAttachments.error,
            });
          }
          const result = await spawnAcpDirect(
            {
              ...spawnParams,
              resumeSessionId,
              streamTo,
              attachments: acpAttachments?.attachments,
            },
            withParentExecutionIdentity(
              {
                ...inheritedSpawnContext(),
                currentMessagingTarget: opts?.currentMessagingTarget,
                agentGroupId: opts?.agentGroupId ?? undefined,
              },
              parentExecutionIdentityToken,
            ),
          );
          recordAcceptedSessionSpawn(result, "isolated");
          return spawnResult(result);
        }

        const { spawnSubagentDirect } = await loadSubagentSpawnModule();
        assertActive();
        const checkoutParams = params.worktree === true ? params : {};
        const result = await spawnSubagentDirect(
          {
            ...spawnParams,
            projectId: readToolStringParam(checkoutParams, "projectId"),
            worktree: params.worktree === true,
            worktreeName: readToolStringParam(checkoutParams, "worktreeName"),
            worktreeBaseRef: readToolStringParam(checkoutParams, "worktreeBaseRef"),
            collect: hasCollectParam ? collect : undefined,
            outputSchema:
              params.outputSchema && typeof params.outputSchema === "object"
                ? (params.outputSchema as Record<string, unknown>)
                : undefined,
            fastMode:
              params.fastMode === true ||
              params.fastMode === false ||
              params.fastMode === "auto" ||
              params.fastMode === "ultrafast"
                ? params.fastMode
                : undefined,
            cyberAccessProgram,
            groupId: readToolStringParam(params, "groupId"),
            swarmLaunchReplayKey:
              typeof params[SWARM_CODE_MODE_IDEMPOTENCY_KEY] === "string"
                ? params[SWARM_CODE_MODE_IDEMPOTENCY_KEY]
                : undefined,
            swarmLaunchRequestFingerprint:
              typeof params[SWARM_CODE_MODE_REQUEST_FINGERPRINT] === "string"
                ? params[SWARM_CODE_MODE_REQUEST_FINGERPRINT]
                : undefined,
            context,
            lightContext,
            ...(params.blind === true ? { blind: true } : {}),
            completionTarget,
            attachments,
            attachMountPath:
              params.attachAs && typeof params.attachAs === "object"
                ? readToolStringParam(params.attachAs as Record<string, unknown>, "mountPath")
                : undefined,
          },
          withParentExecutionIdentity(
            withExecRequestOwners(
              {
                ...inheritedSpawnContext(),
                signal: executionSignal,
                requesterThinkingLevel: opts?.requesterThinkingLevel,
                ...(collect ? captureCollectorPluginContext(tool, _toolCallId) : {}),
                requesterThinkingExplicit,
                requesterModel: opts?.requesterModel,
                currentMessagingTarget: opts?.currentMessagingTarget ?? opts?.currentChannelId,
                agentGroupId: opts?.agentGroupId,
                agentGroupChannel: opts?.agentGroupChannel,
                requesterRunId: opts?.requesterRunId,
              },
              requestOwners,
            ),
            parentExecutionIdentityToken,
          ),
        );

        recordAcceptedSessionSpawn(result, result.context);
        return spawnResult(result);
      }),
    ),
  };
  return opts?.workerPlacement
    ? tool
    : bindCollectorSpawnTool(tool, parameters.properties, opts?.signal);
}
