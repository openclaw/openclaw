import { hasAnyAuthProfileStoreSourceAsync } from "../../agents/auth-profiles/source-check.js";
import { resolveContextTokensForModel } from "../../agents/context.js";
import { resolveConversationCapabilityProfile } from "../../agents/conversation-capability-profile.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { resolveExecDefaults } from "../../agents/exec-defaults.js";
import { prepareInstalledSkillCatalog } from "../../agents/installed-skill-runtime.js";
import { supportsModelTools } from "../../agents/model-tool-support.js";
import { prepareCoreToolPolicy } from "../../agents/prepared-tool-surface.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import { resolveSandboxToolPolicyForAgent } from "../../agents/sandbox/tool-policy.js";
import { projectEffectiveExecPolicy } from "../../agents/session-permission-exec-mode.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import {
  prepareAgentToolSurfacePresentation,
  type AgentToolSurfacePlanParams,
} from "../../agents/tool-surface-plan.js";
import { messageToolOwnsVisibleReply } from "../../auto-reply/source-reply-delivery-mode.js";
import { logWarn } from "../../logger.js";
import type { WorkerToolAuthority } from "../../worker/launch-descriptor.js";
import type { WorkerSessionPlacementIdentity } from "./placement-record.js";

export async function resolveWorkerToolAuthority(params: {
  modelRef: { provider: string; model: string };
  turn: SessionPlacementTurnParams;
  model?: AgentToolSurfacePlanParams["model"];
  placement: Pick<WorkerSessionPlacementIdentity, "agentId" | "sessionKey">;
  assertCurrent(this: void): void;
  computerAvailable?: boolean;
}) {
  const turn = params.turn;
  const authSourceAgentDir = turn.agentDir?.trim();
  const authProfileStoreSource = authSourceAgentDir
    ? await hasAnyAuthProfileStoreSourceAsync(authSourceAgentDir)
    : false;
  params.assertCurrent();
  turn.abortSignal?.throwIfAborted();
  const sandboxSessionKey =
    turn.sandboxSessionKey?.trim() || turn.sessionKey?.trim() || turn.sessionId;
  const sandbox = resolveSandboxRuntimeStatus({
    cfg: turn.config,
    sessionKey: sandboxSessionKey,
    agentId: turn.agentId,
  });
  const capabilityProfile = resolveConversationCapabilityProfile({
    ...turn,
    sandboxSessionKey,
    sessionKey: sandboxSessionKey,
    runSessionKey: turn.sessionKey,
    agentId: turn.sandboxAgentId ?? turn.agentId,
    modelProvider: params.modelRef.provider,
    modelId: params.modelRef.model,
    sandboxToolPolicy: sandbox.sandboxed
      ? resolveSandboxToolPolicyForAgent(turn.config, sandbox.classificationAgentId, {
          containedToolNames: params.computerAvailable ? ["computer"] : [],
        })
      : undefined,
    runtimeToolAllowlist: turn.toolsAllow,
    inheritRuntimeToolAllowlist: true,
  });
  const contextWindow =
    resolveContextTokensForModel({
      cfg: turn.config ?? {},
      provider: params.modelRef.provider,
      model: params.modelRef.model,
      allowAsyncLoad: false,
    }) ?? DEFAULT_CONTEXT_TOKENS;
  const corePolicy = prepareCoreToolPolicy({
    ...turn,
    agentId: capabilityProfile.policy.agentId,
    sessionPermissionPolicy: turn.permissionMode
      ? { mode: turn.permissionMode, root: turn.workspaceDir }
      : undefined,
    modelProvider: params.modelRef.provider,
    modelId: params.modelRef.model,
    modelContextWindowTokens: Math.min(contextWindow, turn.contextTokenBudget ?? contextWindow),
  });
  const defaults = resolveExecDefaults({
    ...turn,
    cfg: turn.config,
    sessionEntry: turn.execSession,
    sessionKey: sandboxSessionKey,
  });
  const policy = projectEffectiveExecPolicy({
    base: { ...defaults, host: defaults.effectiveHost },
    scheduledExecTarget: turn.scheduledToolPolicy?.execTarget,
  });
  // A captured target cannot create the worker's missing host/approval transport.
  const execUnavailable =
    policy.ask === "always" ||
    (turn.scheduledToolPolicy?.execTarget !== undefined && defaults.effectiveHost !== "gateway");
  const { effectiveHost: host, security, node: configuredNode } = defaults;
  const node = configuredNode?.trim();
  const exec: NonNullable<WorkerToolAuthority["exec"]> = {
    security,
    ask: policy.ask ?? defaults.ask,
    safeBins: [],
    ...(host === "node" ? { host, ...(node ? { node } : {}) } : { host }),
  };
  if (execUnavailable) {
    logWarn(
      "Worker exec/process withheld: captured exec policy requires local host or interactive approval. Run this turn locally.",
    );
  }
  const presentation = prepareAgentToolSurfacePresentation({
    ...turn,
    agentId: params.placement.agentId,
    sessionKey: turn.sandboxSessionKey ?? params.placement.sessionKey,
    model: params.model,
    modelProvider: params.modelRef.provider,
    modelId: params.modelRef.model,
    toolsEnabled: supportsModelTools(params.model ?? {}),
    forceDirectMessageTool: messageToolOwnsVisibleReply(turn),
    isRawModelRun: turn.modelRun === true || turn.promptMode === "none",
    forceCodeModeControls: turn.forceCodeModeTools,
  });
  const installedSkills = prepareInstalledSkillCatalog({
    snapshot: turn.skillsSnapshot,
    workspaceDir: turn.bootstrapWorkspaceDir ?? turn.workspaceDir,
    assertCurrent: params.assertCurrent,
  });
  presentation.skills = installedSkills.map(({ name, description, location }) => ({
    name,
    description,
    location,
  }));
  return {
    authProfileStoreSource,
    capabilityProfile,
    policy: corePolicy,
    exec,
    execUnavailable,
    presentation,
    installedSkills,
  };
}
