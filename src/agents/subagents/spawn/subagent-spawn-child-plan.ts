import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { inheritSessionCreationPolicy } from "../../../config/sessions/session-entry-provenance.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../../../routing/session-key.js";
import { resolveUserPath } from "../../../utils.js";
import { resolveAgentDir } from "../../agent-scope-config.js";
import { resolveSpawnSandboxError, mintSpawnSessionKey } from "../../spawn-plan.js";
import {
  resolveRequesterOriginForChild,
  resolveSpawnRequesterConversationTarget,
} from "../../spawn-requester-origin.js";
import {
  mapToolContextToSpawnedRunMetadata,
  resolveSpawnedWorkspaceInheritance,
} from "../../spawned-context.js";
import type { SubagentLaunchAuthorization } from "./subagent-launch-authorization.js";
import {
  rejectSubagentSpawnRequest,
  type SpawnSubagentContext,
  type SpawnSubagentParams,
  type SpawnSubagentResult,
} from "./subagent-spawn-contract.js";
import { resolveSubagentModelAndThinkingPlan } from "./subagent-spawn-plan.js";
import {
  resolveRequesterFastMode,
  resolveRequesterPreferences,
} from "./subagent-spawn-requester-prefs.js";
import {
  normalizeDeliveryContext,
  resolveAgentConfig,
  resolveSandboxRuntimeStatus,
  resolveSandboxRuntimeStatusAsync,
} from "./subagent-spawn.runtime.js";

export async function resolveSubagentChildPlan(params: {
  request: SpawnSubagentParams;
  ctx: SpawnSubagentContext;
  cfg: OpenClawConfig;
  requesterInternalKey: string;
  requesterAgentId: string;
  requesterEntry: SessionEntry | undefined;
  targetAgentId: string;
  sandboxMode: "require" | "inherit";
  swarmEnabled: boolean;
  /** Active requester sandbox classification from the spawn tool, preferred over key-derived
   * status so durable-lineage key substitution does not weaken sandbox admission. */
  requesterSandboxed?: boolean;
}) {
  const requestedCwd = normalizeOptionalString(params.request.cwd);
  const senderRestricted = params.ctx.inheritedToolPolicySource === "sender";
  const requesterRoot = params.ctx.sessionPermissionPolicy?.root ?? params.ctx.workspaceDir;
  if (
    senderRestricted &&
    (params.request.worktree ||
      params.request.projectId ||
      (requestedCwd &&
        (!requesterRoot || resolveUserPath(requestedCwd) !== resolveUserPath(requesterRoot))))
  ) {
    return rejectSubagentSpawnRequest(
      "forbidden",
      "This sender's helpers must keep the requester's workspace and session root. Omit cwd, projectId, and worktree.",
    );
  }
  const toolSpawnMetadata = mapToolContextToSpawnedRunMetadata(params.ctx);
  const inheritedWorkspaceDir =
    params.targetAgentId !== params.requesterAgentId ? undefined : toolSpawnMetadata.workspaceDir;
  const spawnedWorkspaceDir = resolveSpawnedWorkspaceInheritance({
    config: params.cfg,
    targetAgentId: params.targetAgentId,
    explicitWorkspaceDir: inheritedWorkspaceDir,
  });
  const requesterConversation = resolveSpawnRequesterConversationTarget(params.ctx);
  const requesterOrigin = normalizeDeliveryContext({
    channel: params.ctx.agentChannel,
    accountId: params.ctx.agentAccountId,
    ...requesterConversation,
  });
  const childSessionOrigin = resolveRequesterOriginForChild({
    cfg: params.cfg,
    targetAgentId: params.targetAgentId,
    requesterAgentId: params.requesterAgentId,
    requesterChannel: params.ctx.agentChannel,
    requesterAccountId: params.ctx.agentAccountId,
    requesterTo: requesterConversation.to,
    requesterThreadId: requesterConversation.threadId,
    requesterGroupSpace: params.ctx.agentGroupSpace,
    requesterMemberRoleIds: params.ctx.agentMemberRoleIds,
  });
  const incognito = isIncognitoSessionKey(params.requesterInternalKey);
  const mintedChildSessionKey = mintSpawnSessionKey({
    targetAgentId: params.targetAgentId,
    backend: "subagent",
  });
  const childSessionKey = incognito
    ? mintedChildSessionKey.replace(":subagent:", ":subagent:incognito-")
    : mintedChildSessionKey;
  const requesterRuntime = await resolveSandboxRuntimeStatusAsync({
    cfg: params.cfg,
    sessionKey: params.requesterInternalKey,
    agentId: params.requesterAgentId,
    preparedSessionEntry: params.requesterEntry ?? null,
  });
  const creationPolicy = inheritSessionCreationPolicy(
    {
      sandbox: requesterRuntime.sandboxRequired ? "required" : undefined,
      createdActor: requesterRuntime.createdActor,
    },
    { type: "agent", id: params.requesterAgentId },
  );
  // A fresh child has no stored row yet; admission must include its inherited isolation.
  const childRuntimeSandboxed =
    creationPolicy.sandbox === "required" ||
    resolveSandboxRuntimeStatus({
      cfg: params.cfg,
      sessionKey: childSessionKey,
      preparedSessionEntry: null,
    }).sandboxed;
  const childCwd =
    requestedCwd ?? (senderRestricted && !childRuntimeSandboxed ? requesterRoot : undefined);
  const spawnedCwd = childCwd ? resolveUserPath(childCwd) : undefined;
  const sandboxError = resolveSpawnSandboxError({
    backend: "subagent",
    // Prefer the explicit active classification from the spawn tool; fall back to key-derived
    // status. Mirrors the visible/ACP paths so durable parent-lineage keys do not reclassify
    // an actively sandboxed requester as unsandboxed.
    requesterSandboxed: params.requesterSandboxed === true || requesterRuntime.sandboxed,
    childSandboxed: childRuntimeSandboxed,
    sandbox: params.sandboxMode,
  });
  if (sandboxError) {
    return rejectSubagentSpawnRequest("forbidden", sandboxError);
  }
  const spawnedWorkspaceCwd = spawnedWorkspaceDir
    ? resolveUserPath(spawnedWorkspaceDir)
    : undefined;
  if (childRuntimeSandboxed && spawnedCwd && spawnedCwd !== spawnedWorkspaceCwd) {
    return rejectSubagentSpawnRequest(
      "forbidden",
      "cwd override is not supported for sandboxed subagent runs; omit cwd or use the target agent workspace as cwd",
    );
  }
  const targetAgentDir = resolveAgentDir(params.cfg, params.targetAgentId);
  const requesterAgentConfig = resolveAgentConfig(params.cfg, params.requesterAgentId);
  const targetAgentConfig = resolveAgentConfig(params.cfg, params.targetAgentId);
  const requesterThinkingExplicit =
    // SAFETY: Host tool construction adds this optional bit without changing the public context.
    (params.ctx as SpawnSubagentContext & { requesterThinkingExplicit?: boolean })
      .requesterThinkingExplicit;
  const requesterPreferences =
    params.ctx.requesterThinkingLevel === undefined ||
    (params.targetAgentId === params.requesterAgentId && !params.ctx.requesterModel)
      ? resolveRequesterPreferences(params)
      : undefined;
  params.ctx.assertActive?.();
  // The active turn owns inherited effort; saved preferences may already describe
  // a later turn and cannot represent one-shot overrides.
  const callerThinkingRaw =
    params.ctx.requesterThinkingLevel ?? requesterPreferences?.thinkingLevel;
  const callerThinkingExplicit =
    params.ctx.requesterThinkingLevel !== undefined
      ? requesterThinkingExplicit
      : requesterPreferences?.thinkingExplicit;
  const modelPlan = await resolveSubagentModelAndThinkingPlan({
    cfg: params.cfg,
    targetAgentId: params.targetAgentId,
    requesterAgentConfig,
    targetAgentConfig,
    modelOverride: params.request.model,
    thinkingOverrideRaw: params.request.thinking,
    callerThinkingRaw,
    callerThinkingExplicit,
    inheritedModel:
      params.targetAgentId === params.requesterAgentId
        ? (params.ctx.requesterModel ?? requesterPreferences?.model)
        : undefined,
    fastMode: params.request.fastMode,
    workspaceDir: spawnedWorkspaceDir,
    requiresTools: params.request.outputSchema !== undefined,
  });
  params.ctx.assertActive?.();
  if (modelPlan.status === "error") {
    return {
      ok: false as const,
      result: {
        status: "error",
        error: modelPlan.error,
        ...(params.request.outputSchema ? { childSessionKey } : {}),
      } satisfies SpawnSubagentResult,
    };
  }
  const { resolvedModel } = modelPlan;
  if (params.swarmEnabled && params.request.fastMode === undefined) {
    const fastMode = resolveRequesterFastMode({
      ...params,
      requesterModel: params.ctx.requesterModel,
      childModel: resolvedModel,
    });
    if (fastMode !== undefined) {
      modelPlan.initialSessionPatch.fastMode = fastMode;
    }
  }
  const launchAuthorization: SubagentLaunchAuthorization | undefined = params.request.model?.trim()
    ? { modelOverride: modelPlan.modelRef }
    : undefined;
  return {
    ok: true as const,
    resolved: {
      spawnedCwd,
      toolSpawnMetadata,
      spawnedWorkspaceDir,
      requesterOrigin,
      childSessionOrigin,
      // Forks, delayed collectors, and thread setup retain ordinary admission.
      firstAdmission:
        params.request.context === "isolated" &&
        !incognito &&
        !params.request.collect &&
        !params.request.thread &&
        params.requesterAgentId === params.targetAgentId
          ? { delivery: childSessionOrigin, group: toolSpawnMetadata }
          : undefined,
      incognito,
      childSessionKey,
      childRuntimeSandboxed,
      creationPolicy,
      targetAgentDir,
      modelPlan,
      launchAuthorization,
      resolvedModelMetadata: {
        resolvedModel,
        resolvedProvider: modelPlan.modelRef.provider,
      },
    },
  };
}
