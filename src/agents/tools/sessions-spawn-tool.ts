import { Type } from "typebox";
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
} from "../inherited-tool-deny.js";
import { optionalStringEnum, requesterProfileSchema } from "../schema/typebox.js";
import { withParentExecutionIdentity } from "../subagents/spawn/execution-identity-spawn-context.js";
import { resolveAcpSessionsSpawnImageAttachments } from "../subagents/spawn/subagent-attachments.js";
import {
  SUBAGENT_SPAWN_CONTEXT_MODES,
  SUBAGENT_SPAWN_MODES,
  spawnSubagentDirect,
} from "../subagents/spawn/subagent-spawn.js";
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
  describeSubagentSpawnContext,
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
import {
  maybeSpawnVisibleSession,
  type SessionsSpawnToolOptions,
} from "./sessions-spawn-visible.js";
import { SESSIONS_SPAWN_SESSION_SCHEMA } from "./sessions-spawn-visible.schema.js";

const SESSIONS_SPAWN_RUNTIMES = ["subagent", "acp"] as const;
const SESSIONS_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
// Keep the schema local to avoid a circular import through acp-spawn/openclaw-tools.
const SESSIONS_SPAWN_ACP_STREAM_TARGETS = ["parent"] as const;
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

function addRoleToFailureResult<T extends { status: string }>(result: T, role: string | undefined) {
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

function resolveSessionsSpawnThreadAvailability(opts?: {
  config?: OpenClawConfig;
  agentChannel?: string;
  agentAccountId?: string;
}) {
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

function createSessionsSpawnToolSchema(params: {
  acpAvailable: boolean;
  threadAvailable: boolean;
  subagentThreadAvailable: boolean;
  swarmEnabled: boolean;
}) {
  const spawnModes = params.threadAvailable ? SUBAGENT_SPAWN_MODES : (["run"] as const);
  const schema = {
    task: Type.String(),
    user: requesterProfileSchema(),
    taskName: Type.Optional(
      Type.String({
        description:
          "Stable later-target alias; starts lowercase letter; then lowercase/digit/_/-.",
      }),
    ),
    label: Type.Optional(
      Type.String({
        description: "Short task title shown in UI lists; name the work, not the agent.",
      }),
    ),
    runtime: optionalStringEnum(
      params.acpAvailable ? SESSIONS_SPAWN_RUNTIMES : (["subagent"] as const),
      { description: 'Runtime; visible=true and managed worktrees require "subagent".' },
    ),
    agentId: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    runTimeoutSeconds: Type.Optional(
      Type.Integer({
        minimum: 0,
        description:
          "Child run timeout in seconds; overrides the configured subagent default and is preserved on native continuations. Zero disables the timeout; requester wake turns use their own budget.",
      }),
    ),
    thinking: Type.Optional(
      Type.String({ description: "Thinking override; unavailable with visible=true." }),
    ),
    cwd: Type.Optional(
      Type.String({
        description:
          "Child working directory. Visible paths outside configured agent workspaces require operator.admin. Mutually exclusive with projectId/projectGitUrl. With no source selector and worktree=true: inherit the same-agent parent managed repository; otherwise use the target agent workspace.",
      }),
    ),
    ...(params.threadAvailable
      ? {
          thread: Type.Optional(
            Type.Boolean({
              description:
                'Bind to the current conversation or a new thread, as supported by the channel; true defaults mode="session"; unavailable with visible=true.',
            }),
          ),
        }
      : {}),
    mode: optionalStringEnum(spawnModes, {
      description: params.threadAvailable
        ? '"run" one-shot; "session" persistent/thread-bound. Visible sessions accept only omitted/default "run" and remain persistent.'
        : '"run" one-shot. Visible sessions accept omitted/default "run" and remain persistent.',
    }),
    cleanup: optionalStringEnum(["delete", "keep"] as const, {
      description:
        "Hidden session cleanup; delete snapshots and removes its managed worktree through session cleanup. visible=true always keeps the session.",
    }),
    expectsCompletionMessage: Type.Optional(
      Type.Boolean({
        description:
          "false: fire-and-forget; requester gets no completion handoff when the child finishes.",
      }),
    ),
    completionTarget: optionalStringEnum(["parent"] as const, {
      description:
        "parent: return results in a private requester turn; no automatic channel delivery. After sessions_yield, answer under the conversation's normal reply rules (NO_REPLY stays silent). Native hidden run only; unavailable with ACP, collect, visible, thread, session mode, or expectsCompletionMessage=false.",
    }),
    sandbox: optionalStringEnum(SESSIONS_SPAWN_SANDBOX_MODES, {
      description: '"inherit" parent sandbox policy; "require" fails unless child is sandboxed.',
    }),
    context: optionalStringEnum(SUBAGENT_SPAWN_CONTEXT_MODES, {
      description: describeSubagentSpawnContext(params.subagentThreadAvailable),
    }),
    lightContext: Type.Optional(
      Type.Boolean({
        description: "Light bootstrap; subagent only; unavailable with visible=true.",
      }),
    ),
    ...(params.swarmEnabled
      ? {
          collect: Type.Optional(
            Type.Boolean({
              description:
                "Swarm collector child for large parallel fan-out, not one or a few children; no completion notification.",
            }),
          ),
          outputSchema: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description: "JSON Schema for the child's structured result; requires collect=true.",
            }),
          ),
          fastMode: Type.Optional(
            Type.Union([Type.Boolean(), Type.Literal("auto"), Type.Literal("ultrafast")]),
          ),
          groupId: Type.Optional(
            Type.String({
              description: "Groups parallel collector children; requires collect=true.",
            }),
          ),
        }
      : {}),
    ...SESSIONS_SPAWN_SESSION_SCHEMA,

    attachments: Type.Optional(
      Type.Array(
        Type.Object({
          name: Type.String(),
          content: Type.String(),
          encoding: optionalStringEnum(["utf8", "base64"] as const),
          mimeType: Type.Optional(Type.String()),
        }),
        {
          maxItems: 50,
          description: "Inline snapshots; visible=true accepts only an empty array.",
        },
      ),
    ),
    attachAs: Type.Optional(
      Type.Object(
        {
          mountPath: Type.Optional(Type.String()),
        },
        {
          description:
            "Attachment mount hint; visible=true accepts only an omitted or blank mountPath.",
        },
      ),
    ),
    ...(params.acpAvailable
      ? {
          resumeSessionId: Type.Optional(
            Type.String({
              description: "ACP resume id already recorded for requester; ignored by subagent.",
            }),
          ),
          streamTo: optionalStringEnum(SESSIONS_SPAWN_ACP_STREAM_TARGETS, {
            description: 'ACP only; "parent" streams turn to requester. Ignored by subagent.',
          }),
        }
      : {}),
  };
  return Type.Object(schema);
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
  opts?: SessionsSpawnToolOptions & { workerPlacement?: boolean },
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
    description: opts?.workerPlacement
      ? PLACED_SESSIONS_SPAWN_DESCRIPTION
      : describeSessionsSpawnTool({
          acpAvailable,
          threadAvailable,
          subagentThreadAvailable: threadAvailability.subagent,
          swarmEnabled: swarmConfig.enabled,
          sessionToolsVisibility,
          spawnRestricted: restrictToSpawned,
        }),
    parameters: opts?.workerPlacement ? PlacedSessionsSpawnSchema : parameters,
    execute: wrapGatewayPersonalToolExecution(async (_toolCallId, args, signal) =>
      withToolEffectBoundary(async (onSpawnEffectsStart) => {
        const operatorSelection = resolveGatewayToolOperatorSelection();
        const executionSignal =
          signal && opts?.signal
            ? AbortSignal.any([signal, opts.signal])
            : (signal ?? opts?.signal);
        const assertSourceExecution = captureAgentToolSourceExecutionGuard(executionSignal);
        const assertSourceActive = () => {
          assertSourceExecution();
          operatorSelection.assertCurrent();
        };
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
        const cleanup = params.cleanup === "delete" ? "delete" : "keep";
        const expectsCompletionMessage = !collect && params.expectsCompletionMessage !== false;
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
        const spawnVisible = () =>
          maybeSpawnVisibleSession({
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
          runtime === "acp"
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
          runtime === "acp"
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
          ? (params.attachments as Parameters<typeof spawnSubagentDirect>[0]["attachments"])
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
          requesterTurnRunId: opts?.requesterTurnRunId,
          completionOwnerKey: opts?.completionOwnerKey,
          requesterAgentIdOverride: opts?.requesterAgentIdOverride,
          agentChannel: opts?.agentChannel,
          agentAccountId: opts?.agentAccountId,
          agentTo: opts?.agentTo,
          agentThreadId: opts?.agentThreadId,
          currentChannelId: opts?.currentChannelId,
          currentMessageId: opts?.currentMessageId,
          agentGroupSpace: opts?.agentGroupSpace,
          agentMemberRoleIds: opts?.agentMemberRoleIds,
          sandboxed: opts?.sandboxed,
          inheritedToolAllowlist: opts?.inheritedToolAllowlist,
          inheritedToolDenylist: opts?.inheritedToolDenylist,
        });

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
          return jsonResult(addRoleToFailureResult(result, requestedAgentId));
        }

        const result = await spawnSubagentDirect(
          {
            ...spawnParams,
            projectId: readToolStringParam(params, "projectId"),
            worktree: params.worktree === true,
            worktreeName: readToolStringParam(params, "worktreeName"),
            worktreeBaseRef: readToolStringParam(params, "worktreeBaseRef"),
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
            completionTarget,
            attachments,
            attachMountPath:
              params.attachAs && typeof params.attachAs === "object"
                ? readToolStringParam(params.attachAs as Record<string, unknown>, "mountPath")
                : undefined,
          },
          withParentExecutionIdentity(
            {
              ...inheritedSpawnContext(),
              requesterThinkingLevel: opts?.requesterThinkingLevel,
              requesterModel: opts?.requesterModel,
              currentMessagingTarget: opts?.currentMessagingTarget ?? opts?.currentChannelId,
              agentGroupId: opts?.agentGroupId,
              agentGroupChannel: opts?.agentGroupChannel,
              workspaceDir: opts?.workspaceDir,
              sessionPermissionPolicy: opts?.sessionPermissionPolicy,
              requesterRunId: opts?.requesterRunId,
            },
            parentExecutionIdentityToken,
          ),
        );

        recordAcceptedSessionSpawn(result, result.context);
        return jsonResult(addRoleToFailureResult(result, requestedAgentId));
      }),
    ),
  };
  return bindCollectorSpawnTool(tool, parameters.properties, opts?.signal);
}
