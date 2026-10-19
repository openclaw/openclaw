import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { Value } from "typebox/value";
import { readMissingScopeErrorDetails } from "../../../packages/gateway-protocol/src/gateway-error-details.js";
import type { SessionsDispatchResult } from "../../../packages/gateway-protocol/src/schema/session-placement.js";
import type { CyberAccessProgram } from "../../../packages/gateway-protocol/src/schema/sessions-row.js";
import { readChildSessionPublication } from "../../channels/message-access/child-session-publication.js";
import { DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH } from "../../config/agent-limits.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveControlUiSessionUrl } from "../../config/control-ui-link-base.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { attributeDelegatedSessionCreator } from "../../config/sessions/session-entry-provenance.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { buildDashboardSessionTitleSource } from "../../gateway/dashboard-session-title.js";
import { ADMIN_SCOPE } from "../../gateway/method-scopes.js";
import { resolveWorkspacePathContainment } from "../../gateway/server-methods/workspace-path-containment.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../../gateway/session-utils-store-worker.js";
import { resolveWorkerPlacementDestination } from "../../gateway/worker-environments/placement-destination.js";
import { readExecRequestOwners, withExecRequestOwners } from "../../infra/exec-request-context.js";
import { isPathInside } from "../../infra/path-guards.js";
import { getCanonicalGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { isValidAgentId, normalizeAgentId } from "../../routing/session-key.js";
import { recordSessionParticipantBestEffort } from "../../sessions/session-participant-recording.js";
import { resolveUserPath } from "../../utils.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import { listAgentIds, resolveSessionAgentId } from "../agent-scope.js";
import { runWithAgentToolSourceExecutionScope } from "../agent-tool-source-execution-guard.js";
import { reserveChildAdmissionSlot } from "../child-admission.js";
import { prepareNativeDelegatedToolPolicy } from "../delegated-tool-policy.js";
import { resolveRunEntryCliRuntime } from "../embedded-agent-runner/run-entry-runtime.js";
import { resolveAgentIdentity } from "../identity.js";
import {
  resolveSandboxRuntimeStatus,
  resolveSandboxRuntimeStatusAsync,
} from "../sandbox/runtime-status.js";
import { resolveSpawnAdmission } from "../spawn-plan.js";
import { resolveSpawnedWorkspaceInheritance } from "../spawned-context.js";
import { prepareSubagentSessionListReadCache } from "../subagents/registry/subagent-registry-state.js";
import { registerSubagentRun } from "../subagents/registry/subagent-registry.js";
import { getSubagentDepthFromSessionStoreInWorker } from "../subagents/spawn/subagent-depth.js";
import { terminateAcceptedCollectorRun } from "../subagents/spawn/subagent-spawn-cleanup.js";
import {
  callNativeSubagentGateway,
  captureSubagentSpawnGatewayContext,
  resolveSubagentAgentGatewayTimeoutMs,
} from "../subagents/spawn/subagent-spawn-gateway.js";
import { resolveSubagentSpawnOwnership } from "../subagents/spawn/subagent-spawn-ownership.js";
import {
  resolveConfiguredSubagentRunTimeoutSeconds,
  resolveSubagentModelAndThinkingPlan,
} from "../subagents/spawn/subagent-spawn-plan.js";
import {
  resolveRequesterPreferences,
  resolveSubagentCyberAccessProgram,
} from "../subagents/spawn/subagent-spawn-requester-prefs.js";
import { buildSubagentTaskMessage } from "../subagents/spawn/subagent-system-prompt.js";
import { resolveAgentTimeoutMs } from "../timeout.js";
import { validateName } from "../worktrees/name.js";
import { normalizeToolModelOverride, readToolStringParam, ToolInputError } from "./common.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import {
  callInProcessGatewayTool,
  callInProcessGatewayToolWithCreation,
  runWithGatewayToolCleanupContext,
  type InProcessGatewayCaller,
} from "./in-process-gateway.js";
import { startVisibleCloudSession } from "./sessions-spawn-cloud.js";
import type { SessionsSpawnToolOptions } from "./sessions-spawn-options.js";
import {
  cleanupVisibleSpawnSession,
  summarizeVisibleSessionSpawnError,
} from "./sessions-spawn-visible-cleanup.js";
import { resolveVisibleSessionOwner } from "./sessions-spawn-visible-owner.js";
import { resolveVisibleSpawnThinkingLevel } from "./sessions-spawn-visible-thinking.js";
import {
  correctedVisibleSpawnCall,
  SessionsSpawnPlacementSchema,
  validateVisibleSpawnOptions,
} from "./sessions-spawn-visible.schema.js";

type VisibleSessionsSpawnOptions = SessionsSpawnToolOptions & {
  onSpawnEffectsStart?: () => void;
  assertActive?: () => void;
};

export async function maybeSpawnVisibleSession(params: {
  raw: Record<string, unknown>;
  task: string;
  taskName?: string;
  label: string;
  runtime: "subagent" | "acp";
  requestedAgentId?: string;
  runTimeoutSeconds?: number;
  sandbox: "inherit" | "require";
  expectsCompletionMessage: boolean;
  cyberAccessProgram?: CyberAccessProgram;
  options?: VisibleSessionsSpawnOptions;
}): Promise<Record<string, unknown> | undefined> {
  const promptedAt = Date.now();
  const worktree = params.raw.worktree === true;
  const requestedPlacement = params.raw.placement;
  if (
    requestedPlacement !== undefined &&
    !Value.Check(SessionsSpawnPlacementSchema, requestedPlacement)
  ) {
    throw new ToolInputError(
      'Omit placement for local execution or use {kind: "local"} with no cloud selectors. ' +
        'For a configured cloud profile, use {kind: "profile", profileId, os?, machineClass?} with non-empty selectors, visible=true, and worktree=true.',
    );
  }
  const placement = requestedPlacement?.kind === "profile" ? requestedPlacement : undefined;
  if (placement && (params.raw.visible !== true || !worktree)) {
    throw new ToolInputError(
      `Cloud placement requires visible=true and worktree=true. Corrected call: ${correctedVisibleSpawnCall(params.raw)}`,
    );
  }
  // Hidden native checkout selectors only apply when worktree is explicitly enabled.
  const checkoutParams =
    worktree || params.raw.visible === true || params.runtime === "acp" ? params.raw : {};
  const worktreeName = readToolStringParam(checkoutParams, "worktreeName", {
    trim: false,
    allowEmpty: true,
  });
  if (worktreeName !== undefined) {
    try {
      validateName(worktreeName);
    } catch (error) {
      throw new ToolInputError(error instanceof Error ? error.message : String(error));
    }
  }
  const worktreeBaseRef = readToolStringParam(checkoutParams, "worktreeBaseRef");
  const group = readToolStringParam(params.raw, "group");
  const projectId = readToolStringParam(checkoutParams, "projectId");
  const projectGitUrl = readToolStringParam(params.raw, "projectGitUrl");
  if (params.raw.visible !== true) {
    const visibleOnlyParams = [
      ["group", group],
      ["projectGitUrl", projectGitUrl],
    ] as const;
    const providedVisibleOnlyParams = visibleOnlyParams
      .filter(([, value]) => value !== undefined)
      .map(([name]) => name);
    if (providedVisibleOnlyParams.length > 0) {
      throw new ToolInputError(
        `Parameters require visible=true: ${providedVisibleOnlyParams.join(", ")}. ` +
          `Omit these options to keep the hidden runtime. Corrected visible call: ${correctedVisibleSpawnCall(params.raw)}`,
      );
    }
    if (params.runtime === "acp" && (projectId || worktree || worktreeName || worktreeBaseRef)) {
      throw new ToolInputError(
        'Managed worktree parameters are unavailable with runtime="acp". Use runtime="subagent" with worktree=true, or omit projectId, worktree, worktreeName, and worktreeBaseRef for ACP.',
      );
    }
    return undefined;
  }
  const modelOverride = normalizeToolModelOverride(readToolStringParam(params.raw, "model"));
  const requestedCwd = readToolStringParam(params.raw, "cwd");
  const spawnedCwd = requestedCwd ? resolveUserPath(requestedCwd) : undefined;
  validateVisibleSpawnOptions(params.raw, params.runtime);

  const {
    gatewayContextResolver: resolveGatewayContext,
    requester,
    creatorProfileId,
  } = captureSubagentSpawnGatewayContext();
  const cloudGateway = placement ? resolveGatewayContext?.() : undefined;
  if (placement && (!cloudGateway || cloudGateway.localEmbedded === true)) {
    return {
      status: "forbidden",
      error:
        "Cloud placement requires a live hosted Gateway session; standalone transport is unsupported.",
    };
  }
  const cfg = params.options?.config ?? getRuntimeConfig();
  if (placement) {
    const destination = resolveWorkerPlacementDestination({ cfg, ...placement });
    if (!destination.ok) {
      return { status: "error", error: destination.error };
    }
  }
  const ownership = resolveSubagentSpawnOwnership({
    cfg,
    agentSessionKey: params.options?.agentSessionKey,
    completionOwnerKey: params.options?.completionOwnerKey,
  });
  let assertDelegationCurrent: (() => void) | undefined = undefined;
  const assertActive = composeSessionSourceAssertion([params.options?.assertActive], (source) => {
    source();
    params.options?.signal?.throwIfAborted();
    assertDelegationCurrent?.();
  });
  const requesterTarget = await resolveGatewaySessionStoreTargetInWorker({
    cfg,
    key: ownership.completionRequesterSessionKey,
    agentId: params.options?.requesterAgentIdOverride,
    assertActive,
  });
  const completionEntry = requesterTarget.store[requesterTarget.canonicalKey];
  const completionRequesterSessionId = completionEntry?.sessionId;
  const completionRequesterLifecycleRevision = completionEntry?.lifecycleRevision;
  const requesterKey = ownership.controllerSessionKey;
  const controllerTarget =
    requesterKey === ownership.completionRequesterSessionKey
      ? requesterTarget
      : await resolveGatewaySessionStoreTargetInWorker({
          cfg,
          key: requesterKey,
          agentId: params.options?.requesterAgentIdOverride,
          assertActive,
        });
  assertActive();
  const requesterEntry = controllerTarget.store[controllerTarget.canonicalKey];
  const callerDepth = await getSubagentDepthFromSessionStoreInWorker(requesterKey, {
    cfg,
    agentId: params.options?.requesterAgentIdOverride,
  });
  const maxDepth =
    cfg.agents?.defaults?.subagents?.maxSpawnDepth ?? DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
  if (params.requestedAgentId && !isValidAgentId(params.requestedAgentId)) {
    return {
      status: "error",
      error: `Invalid agentId "${params.requestedAgentId}". Agent IDs must match [a-z0-9][a-z0-9_-]{0,63}.`,
    };
  }
  const requesterAgentId = resolveSessionAgentId({
    config: cfg,
    sessionKey: requesterKey,
    agentId: params.options?.requesterAgentIdOverride,
  });
  const targetAgentId = params.requestedAgentId
    ? normalizeAgentId(params.requestedAgentId)
    : requesterAgentId;
  if (params.raw.context === "fork" && targetAgentId !== requesterAgentId) {
    return {
      status: "error",
      error:
        'context="fork" currently requires the same target agent as the requester; use context="isolated" for cross-agent spawns.',
    };
  }
  if (!params.options?.countActiveRuns) {
    await prepareSubagentSessionListReadCache();
  }
  const resolveAdmission = (pendingChildren = 0) =>
    resolveSpawnAdmission({
      cfg,
      callerDepth,
      requesterSessionKey: requesterKey,
      requesterAgentId,
      targetAgentId,
      requestedAgentId: params.requestedAgentId,
      configuredAgentIds: listAgentIds(cfg),
      additionalActiveChildren: pendingChildren,
      countActiveRuns: params.options?.countActiveRuns,
    });
  const admission = resolveAdmission();
  if (!admission.ok) {
    return { status: "forbidden", error: admission.error };
  }
  const delegation = prepareNativeDelegatedToolPolicy({
    config: cfg,
    requesterAgentId,
    targetAgentId,
    requesterSessionKey: requesterKey,
    context: params.options,
  });
  const delegatedToolPolicy = delegation.policy;
  assertDelegationCurrent = delegation.assertCurrent;
  assertActive();
  if (placement && delegatedToolPolicy) {
    return {
      status: "forbidden",
      error:
        "Delegated tool targets require Gateway-side native execution; cloud placement cannot enforce the live grant.",
    };
  }
  const runTimeoutSeconds = resolveConfiguredSubagentRunTimeoutSeconds({
    cfg,
    runTimeoutSeconds: params.runTimeoutSeconds,
  });
  const requesterRuntime = await resolveSandboxRuntimeStatusAsync({
    cfg,
    sessionKey: requesterKey,
    agentId: requesterAgentId,
    preparedSessionEntry: requesterEntry ?? null,
  });
  // Gateway creation inherits the exact parent's requirement before admitting a child run.
  const childRuntimeSandboxed =
    requesterRuntime.sandboxRequired ||
    resolveSandboxRuntimeStatus({
      cfg,
      sessionKey: `agent:${targetAgentId}:dashboard:pending`,
      preparedSessionEntry: null,
    }).sandboxed;
  const requesterSandboxed = params.options?.sandboxed === true || requesterRuntime.sandboxed;
  if (!childRuntimeSandboxed && (requesterSandboxed || params.sandbox === "require")) {
    return {
      status: "forbidden",
      error: requesterSandboxed
        ? "Sandboxed sessions cannot spawn unsandboxed sessions."
        : 'sessions_spawn sandbox="require" needs sandboxed target.',
    };
  }
  const spawnedWorkspaceDir = resolveSpawnedWorkspaceInheritance({
    config: cfg,
    targetAgentId,
  });
  const spawnedWorkspaceCwd = spawnedWorkspaceDir
    ? resolveUserPath(spawnedWorkspaceDir)
    : undefined;
  // Sandbox mounts only the target workspace; cwd must stay within that boundary.
  if (
    childRuntimeSandboxed &&
    spawnedCwd &&
    (!spawnedWorkspaceCwd || !isPathInside(spawnedWorkspaceCwd, spawnedCwd))
  ) {
    return {
      status: "forbidden",
      error:
        "cwd override is not supported outside the target agent workspace for sandboxed visible session runs",
    };
  }

  const modelPlan = await resolveSubagentModelAndThinkingPlan({
    cfg,
    targetAgentId,
    modelOverride,
    workspaceDir: spawnedWorkspaceDir,
    inheritedModel:
      targetAgentId === requesterAgentId
        ? (params.options?.requesterModel ??
          resolveRequesterPreferences({ cfg, requesterAgentId, requesterEntry }).model)
        : undefined,
  });
  if (modelPlan.status === "error") {
    return { status: "error", error: modelPlan.error };
  }
  const { resolvedModel, inheritedModel, initialSessionPatch } = modelPlan;
  const cyberAccessProgram = resolveSubagentCyberAccessProgram({
    cfg,
    requesterAgentId,
    requesterEntry,
    targetAgentId,
    requested: params.cyberAccessProgram,
    requesterModel: params.options?.requesterModel,
    childModel: resolvedModel,
  });
const thinkingLevel = resolveVisibleSpawnThinkingLevel(resolvedModel, params.raw);
  const { authProfileOverride } = initialSessionPatch;
  // A sandbox-classified visible child must not dispatch to a host-executed CLI
  // backend: the CLI runs as the Gateway OS user outside the configured sandbox
  // while the child session would still be reported sandboxed. The admission
  // above only sees the config-derived classification; re-check once the child
  // model is resolved, mirroring the cron seam guard. The run seam enforces the
  // same invariant for fallback candidates and post-spawn runtime overrides.
  if (childRuntimeSandboxed) {
    const { useCliExecution, cliExecutionProvider } = resolveRunEntryCliRuntime({
      config: cfg,
      provider: modelPlan.modelRef.provider,
      model: modelPlan.modelRef.model,
      agentId: targetAgentId,
      authProfileId: authProfileOverride,
    });
    if (useCliExecution) {
      return {
        status: "forbidden",
        error: `This spawn targets a sandboxed child, but model "${resolvedModel}" runs on host-executed CLI backend "${cliExecutionProvider}" and cannot honor the sandbox. Choose a sandbox-compatible (embedded/API) model for the child, or change the agent's sandbox policy explicitly.`,
      };
    }
  }
  const resolvedModelRef = authProfileOverride
    ? `${resolvedModel}@${authProfileOverride}`
    : resolvedModel;
  const spawnModelAutoSelection =
    initialSessionPatch.modelOverrideSource === "auto"
      ? {
          model: resolvedModelRef,
          hasFallbackOrigin: initialSessionPatch.modelOverrideFallbackOriginModel !== undefined,
        }
      : undefined;
  const reservation = reserveChildAdmissionSlot({
    controllerSessionKey: requesterKey,
    resolveAdmission,
  });
  if (!reservation.ok) {
    return { status: "forbidden", error: reservation.error };
  }
  // Successful admission reserves a child before Gateway work can start.
  params.options?.onSpawnEffectsStart?.();
  try {
    const caller = getGatewayToolCallerIdentity();
    const childSessionPublication = readChildSessionPublication(caller?.operationalRunInstance);
    if (childSessionPublication) {
      childSessionPublication.assertCurrent();
      if (
        caller?.sessionKey !== requesterKey ||
        childSessionPublication.requesterSessionKey !== requesterKey ||
        params.raw.context === "fork"
      ) {
        throw new ToolInputError("Public ingress work requires an immediate isolated child.");
      }
    }
    const gatewayCall = params.options?.callGateway ?? callInProcessGatewayTool;
    const createGatewayCall: InProcessGatewayCaller =
      params.options?.callGateway ??
      ((method, requestParams, requestOptions) =>
        callInProcessGatewayToolWithCreation(
          method,
          requestParams,
          {
            via: "spawn",
            actor: attributeDelegatedSessionCreator(
              { type: "agent", id: requesterAgentId },
              creatorProfileId,
            ),
            requesterSessionKey: requesterKey,
            ...(childSessionPublication ? { childSessionPublication } : {}),
            requesterSenderIsOwner: params.options?.senderIsOwner === true,
            gitContributorProfileId: params.options?.gitContributorProfileId,
            completionOwnerSessionKey: ownership.completionRequesterSessionKey,
            ...(params.options?.sessionPermissionPolicy
              ? { inheritedPermissionMode: params.options.sessionPermissionPolicy.mode }
              : {}),
            ...(spawnModelAutoSelection ? { spawnModelAutoSelection } : {}),
            inheritedToolPolicy: {
              version: 1,
              allow: [...(params.options?.inheritedToolAllowlist ?? [])],
              deny: [...(params.options?.inheritedToolDenylist ?? [])],
              ...(delegatedToolPolicy ? { delegatedToolPolicy } : {}),
            },
            ...(inheritedModel ? { resolvedModel: inheritedModel } : {}),
          },
          requestOptions,
        ));
    let response: {
      key?: string;
      sessionId?: string;
      entry?: Pick<SessionEntry, "createdActor" | "lifecycleRevision" | "owner">;
      publicRead?: boolean;
      runStarted?: boolean;
      runId?: string;
      runError?: unknown;
      placement?: SessionsDispatchResult["placement"];
      initialTaskStatus?: "unknown" | "not-sent";
    };
    const taskMessage = buildSubagentTaskMessage({
      task: params.task,
      spawnMode: "session",
      childDepth: callerDepth + 1,
      maxSpawnDepth: maxDepth,
    });
    try {
      const titleSource = placement && buildDashboardSessionTitleSource({ message: params.task });
      const createParams = {
        agentId: targetAgentId,
        ...(params.label ? { label: params.label } : {}),
        // sessions.create persists the group under the legacy wire field `category`.
        ...(group ? { category: group } : {}),
        model: resolvedModelRef,
        ...(cyberAccessProgram !== undefined ? { cyberAccessProgram } : {}),
...(thinkingLevel ? { thinkingLevel } : {}),
        ...(placement ? { titleSource } : { task: taskMessage }),
        timeoutMs:
          runTimeoutSeconds === 0
            ? 0
            : resolveAgentTimeoutMs({ cfg, overrideSeconds: runTimeoutSeconds }),
        parentSessionKey: requesterKey,
        // Declared spawn lineage: without it the child persists as a depth-0 root
        // and could spawn past maxSpawnDepth.
        spawnDepth: callerDepth + 1,
        ...(params.raw.context === "fork" ? { fork: true } : {}),
        ...(spawnedCwd ? { cwd: spawnedCwd } : {}),
        ...(projectId ? { projectId } : {}),
        ...(projectGitUrl ? { projectGitUrl } : {}),
        ...(worktree ? { worktree: true } : {}),
        ...(worktreeName ? { worktreeName } : {}),
        ...(worktreeBaseRef ? { worktreeBaseRef } : {}),
      };
      response = await runWithAgentToolSourceExecutionScope(assertActive, () =>
        placement
          ? createGatewayCall("sessions.create", createParams, {
              signal: params.options?.signal,
              sessionMutationCommitGuard: assertActive,
              timeoutMs: null,
            })
          : createGatewayCall("sessions.create", createParams),
      );
    } catch (error) {
      const missingScope = readMissingScopeErrorDetails(
        error && typeof error === "object" && "details" in error ? error.details : undefined,
      );
      if (
        spawnedCwd &&
        missingScope?.missingScope === ADMIN_SCOPE &&
        missingScope.requiredScopes.includes(ADMIN_SCOPE) &&
        !(await resolveWorkspacePathContainment(spawnedCwd, cfg))
      ) {
        return {
          status: "forbidden",
          error: `Visible session cwd "${spawnedCwd}" is outside configured agent workspaces and requires operator.admin. Omit cwd to use the target agent workspace, or select a registered project with projectId or a GitHub repository with projectGitUrl. Do not substitute the synchronous \`openclaw agent\` CLI for a persistent visible session.`,
        };
      }
      throw error;
    }
    const childSessionKey = response.key?.trim();
    const sessionId = response.sessionId?.trim();
    const cloudGatewayCall: InProcessGatewayCaller = (method, request, options) =>
      gatewayCall(method, request, { ...options, resolveGatewayContext });
    const cleanupGateway = resolveGatewayContext
      ? (getCanonicalGatewayContextResolver(resolveGatewayContext) ?? resolveGatewayContext)
      : undefined;
    const terminateCloudRun = (key: string, runId: string) =>
      runWithGatewayToolCleanupContext(
        () =>
          terminateAcceptedCollectorRun({
            childSessionKey: key,
            gatewayRunId: runId,
            sessionCleanup: "preserve",
            callGateway: ({ method, params: request, timeoutMs }) => {
              if (!isRecord(request)) {
                throw new Error("Invalid cloud cleanup request");
              }
              return gatewayCall(method, request, {
                timeoutMs,
                resolveGatewayContext: cleanupGateway,
              });
            },
          }),
        cleanupGateway,
      );
    if (placement && childSessionKey && sessionId) {
      response = {
        ...response,
        ...(await startVisibleCloudSession({
          cfg,
          key: childSessionKey,
          sessionId,
          profileId: placement.profileId,
          os: placement.os,
          machineClass: placement.machineClass,
          task: taskMessage,
          runTimeoutSeconds,
          callGateway: cloudGatewayCall,
          launchAgent: async (request, assertDispatchCurrent) => {
            if (params.options?.callGateway) {
              assertDispatchCurrent();
              return await runWithAgentToolSourceExecutionScope(assertActive, () =>
                cloudGatewayCall("agent", request, {
                  sessionMutationCommitGuard: assertDispatchCurrent,
                  timeoutMs: null,
                }),
              );
            }
            return (
              await runWithAgentToolSourceExecutionScope(assertActive, () =>
                callNativeSubagentGateway(
                  {
                    method: "agent",
                    params: request,
                    assertDispatchCurrent,
                    timeoutMs: resolveSubagentAgentGatewayTimeoutMs(runTimeoutSeconds),
                  },
                  { gatewayContextResolver: resolveGatewayContext, requester },
                ),
              )
            ).response;
          },
          terminateRun: (runId) => terminateCloudRun(childSessionKey, runId),
          assertActive,
          signal: params.options?.signal,
        })),
      };
    }
    const runId = response.runId?.trim();
    const lifecycleRevision = response.entry?.lifecycleRevision;
    const runError = response.runError
      ? summarizeVisibleSessionSpawnError(response.runError)
      : "Visible session run failed";
    if (!childSessionKey) {
      return {
        status: "error",
        error: runError,
      };
    }
    const cleanupCreatedSession = () =>
      cleanupVisibleSpawnSession({
        callGateway: gatewayCall,
        childSessionKey,
        expectedSessionId: sessionId,
        expectedLifecycleRevision: lifecycleRevision,
      });
    if (placement && (response.runStarted !== true || !runId)) {
      return {
        status: "error",
        childSessionKey,
        sessionId,
        ...(runId ? { runId } : {}),
        initialTaskStatus: response.initialTaskStatus ?? "not-sent",
        ...(response.placement ? { placement: response.placement } : {}),
        error: `${runError}. Child kept for placement recovery. Inspect this child before retrying; do not spawn a replacement.`,
      };
    }
    if (response.runStarted !== true || !runId) {
      return {
        status: "error",
        error: `${runError}. ${await cleanupCreatedSession()}`,
        childSessionKey,
      };
    }
    if (!sessionId) {
      return {
        status: "error",
        childSessionKey,
        runId,
        error:
          "Visible run cannot be registered because sessions.create did not return its sessionId. Child kept; inspect this child session and run before retrying. Do not spawn a replacement.",
      };
    }
    try {
      if (placement) {
        params.options?.assertActive?.();
      }
      await (params.options?.registerRun ?? registerSubagentRun)(
        {
          runId,
          requesterTurnRunId: params.options?.requesterTurnRunId,
          childSessionKey,
          childAgentId: targetAgentId,
          sessionEntry: { sessionId, lifecycleRevision },
          controllerSessionKey: ownership.controllerSessionKey,
          requesterSessionKey: ownership.completionRequesterSessionKey,
          completionRequesterSessionId,
          completionRequesterLifecycleRevision,
          requesterOrigin: normalizeDeliveryContext({
            channel: params.options?.agentChannel,
            accountId: params.options?.agentAccountId,
            to:
              params.options?.currentMessagingTarget ??
              params.options?.currentChannelId ??
              params.options?.agentTo,
            threadId: params.options?.currentThreadTs ?? params.options?.agentThreadId,
          }),
          requesterDisplayKey: ownership.completionRequesterDisplayKey,
          task: params.task,
          taskName: params.taskName,
          requesterAgentId,
          cleanup: "keep",
          label: params.label || undefined,
          runTimeoutSeconds,
          expectsCompletionMessage: params.expectsCompletionMessage,
          spawnMode: "run",
        },
        withExecRequestOwners(
          {
            assertCurrent: () => {
              params.options?.signal?.throwIfAborted();
              params.options?.assertActive?.();
            },
          },
          !placement && params.runtime === "subagent" && params.options
            ? readExecRequestOwners(params.options)
            : undefined,
        ),
      );
    } catch (error) {
      if (placement) {
        await terminateCloudRun(childSessionKey, runId);
      }
      return {
        status: "error",
        error: `Visible run registration failed: ${summarizeVisibleSessionSpawnError(error)}. ${placement ? "Cloud child kept; inspect its run before retrying." : await cleanupCreatedSession()}`,
        childSessionKey,
        runId,
      };
    }
    recordSessionParticipantBestEffort({
      promptedAt,
      identity: { type: "agent", id: requesterAgentId },
      agentId: targetAgentId,
      sessionKey: childSessionKey,
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: targetAgentId }),
    });
    const ownerLabel = normalizeOptionalString(resolveAgentIdentity(cfg, requesterAgentId)?.name);
    const sessionUrl = resolveControlUiSessionUrl(cfg, {
      sessionKey: childSessionKey,
      fallbackAgentId: targetAgentId,
    });
    return {
      status: "accepted",
      childSessionKey,
      runId,
      mode: "run",
      expectsCompletionMessage: params.expectsCompletionMessage,
      cleanup: "keep",
      ...(response.placement ? { placement: response.placement } : {}),
      ...(sessionUrl ? { sessionUrl } : {}),
      publicRead: response.publicRead === true,
      ...(cyberAccessProgram !== undefined ? { cyberAccessProgram } : {}),
      ...(params.label ? { label: params.label } : {}),
      owner: resolveVisibleSessionOwner(response.entry, requesterAgentId, ownerLabel, cfg),
    };
  } finally {
    reservation.release();
  }
}
