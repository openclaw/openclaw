import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { inheritSessionCreationPolicy } from "../../../config/sessions/session-entry-provenance.js";
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
import type {
  SpawnSubagentContext,
  SpawnSubagentParams,
  SpawnSubagentResult,
} from "./subagent-spawn-contract.js";
import { resolveSubagentModelAndThinkingPlan, splitModelRef } from "./subagent-spawn-plan.js";
import {
  readRequesterFastMode,
  readRequesterModel,
  readRequesterThinkingLevel,
} from "./subagent-spawn-requester-prefs.js";
import {
  normalizeDeliveryContext,
  resolveAgentConfig,
  resolveSandboxRuntimeStatus,
} from "./subagent-spawn.runtime.js";

function buildResolvedSubagentModelMetadata(resolvedModel?: string): {
  resolvedModel?: string;
  resolvedProvider?: string;
} {
  const modelRef = resolvedModel?.trim();
  if (!modelRef) {
    return {};
  }
  const { provider } = splitModelRef(modelRef);
  return {
    resolvedModel: modelRef,
    ...(provider ? { resolvedProvider: provider } : {}),
  };
}

export async function resolveSubagentChildPlan(params: {
  request: SpawnSubagentParams;
  ctx: SpawnSubagentContext;
  cfg: OpenClawConfig;
  requesterInternalKey: string;
  requesterAgentId: string;
  targetAgentId: string;
  sandboxMode: "require" | "inherit";
  swarmEnabled: boolean;
  /** Active requester sandbox classification from the spawn tool, preferred over key-derived
   * status so durable-lineage key substitution does not weaken sandbox admission. */
  requesterSandboxed?: boolean;
}) {
  const requestedCwd = normalizeOptionalString(params.request.cwd);
  const spawnedCwd = requestedCwd ? resolveUserPath(requestedCwd) : undefined;
  const toolSpawnMetadata = mapToolContextToSpawnedRunMetadata({
    agentGroupId: params.ctx.agentGroupId,
    agentGroupChannel: params.ctx.agentGroupChannel,
    agentGroupSpace: params.ctx.agentGroupSpace,
    workspaceDir: params.ctx.workspaceDir,
  });
  const inheritedWorkspaceDir =
    params.targetAgentId !== params.requesterAgentId ? undefined : toolSpawnMetadata.workspaceDir;
  const spawnedWorkspaceDir = resolveSpawnedWorkspaceInheritance({
    config: params.cfg,
    targetAgentId: params.targetAgentId,
    explicitWorkspaceDir: inheritedWorkspaceDir,
  });
  // Thread binding and completion delivery must resolve the requester conversation the
  // same way. CLI runtimes have no agentTo and only carry current* fields, so a
  // child-plan that read agentTo alone could not bind while delivery already had
  // the target (issue #158945). Explicit agentTo remains the fallback, keeping
  // regular channel turns identical.
  const requesterConversation = resolveSpawnRequesterConversationTarget(params.ctx);
  const requesterOrigin = normalizeDeliveryContext({
    channel: params.ctx.agentChannel,
    accountId: params.ctx.agentAccountId,
    ...(requesterConversation.to ? { to: requesterConversation.to } : {}),
    ...(requesterConversation.threadId ? { threadId: requesterConversation.threadId } : {}),
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
  const requesterRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.requesterInternalKey,
    agentId: params.requesterAgentId,
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
    resolveSandboxRuntimeStatus({ cfg: params.cfg, sessionKey: childSessionKey }).sandboxed;
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
    return {
      ok: false as const,
      result: { status: "forbidden", error: sandboxError } satisfies SpawnSubagentResult,
    };
  }
  const spawnedWorkspaceCwd = spawnedWorkspaceDir
    ? resolveUserPath(spawnedWorkspaceDir)
    : undefined;
  if (childRuntimeSandboxed && spawnedCwd && spawnedCwd !== spawnedWorkspaceCwd) {
    return {
      ok: false as const,
      result: {
        status: "forbidden",
        error:
          "cwd override is not supported for sandboxed subagent runs; omit cwd or use the target agent workspace as cwd",
      } satisfies SpawnSubagentResult,
    };
  }
  const targetAgentDir = resolveAgentDir(params.cfg, params.targetAgentId);
  const requesterAgentConfig = resolveAgentConfig(params.cfg, params.requesterAgentId);
  const targetAgentConfig = resolveAgentConfig(params.cfg, params.targetAgentId);
  // The active turn owns inherited effort; saved preferences may already describe
  // a later turn and cannot represent one-shot overrides.
  const callerThinkingRaw =
    params.ctx.requesterThinkingLevel ??
    readRequesterThinkingLevel({
      cfg: params.cfg,
      requesterInternalKey: params.requesterInternalKey,
      requesterAgentId: params.requesterAgentId,
    });
  const modelPlan = await resolveSubagentModelAndThinkingPlan({
    cfg: params.cfg,
    targetAgentId: params.targetAgentId,
    requesterAgentConfig,
    targetAgentConfig,
    modelOverride: params.request.model,
    thinkingOverrideRaw: params.request.thinking,
    callerThinkingRaw,
    inheritedModel:
      params.targetAgentId === params.requesterAgentId
        ? (params.ctx.requesterModel ??
          readRequesterModel({
            cfg: params.cfg,
            requesterInternalKey: params.requesterInternalKey,
            requesterAgentId: params.requesterAgentId,
          }))
        : undefined,
    fastMode: params.request.fastMode,
    workspaceDir: spawnedWorkspaceDir,
    requiresTools: params.request.outputSchema !== undefined,
  });
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
    modelPlan.initialSessionPatch.fastMode = readRequesterFastMode({
      cfg: params.cfg,
      requesterInternalKey: params.requesterInternalKey,
      requesterAgentId: params.requesterAgentId,
      requesterModel: params.ctx.requesterModel,
      childModel: resolvedModel,
    });
  }
  const resolvedLaunchModel = splitModelRef(resolvedModel);
  const launchAuthorization: SubagentLaunchAuthorization | undefined =
    params.request.model?.trim() && resolvedLaunchModel.model
      ? {
          modelOverride: {
            ...(resolvedLaunchModel.provider ? { provider: resolvedLaunchModel.provider } : {}),
            model: resolvedLaunchModel.model,
          },
        }
      : undefined;
  return {
    ok: true as const,
    resolved: {
      spawnedCwd,
      toolSpawnMetadata,
      spawnedWorkspaceDir,
      requesterOrigin,
      childSessionOrigin,
      incognito,
      childSessionKey,
      childRuntimeSandboxed,
      creationPolicy,
      targetAgentDir,
      modelPlan,
      launchAuthorization,
      resolvedModelMetadata: buildResolvedSubagentModelMetadata(resolvedModel),
    },
  };
}
