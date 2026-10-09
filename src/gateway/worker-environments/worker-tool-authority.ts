import { getAgentToolExecutionLocation } from "../../agents/agent-tool-metadata.js";
import { createOpenClawCodingToolsInternalAsync } from "../../agents/agent-tools.js";
import { hasAnyAuthProfileStoreSourceAsync } from "../../agents/auth-profiles/source-check.js";
import { resolveContextTokensForModel } from "../../agents/context.js";
import { resolveConversationCapabilityProfile } from "../../agents/conversation-capability-profile.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { applyEmbeddedAttemptToolsAllow } from "../../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
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
import type { AnyAgentTool } from "../../agents/tools/common.js";
import { messageToolOwnsVisibleReply } from "../../auto-reply/source-reply-delivery-mode.js";
import { logInfo, logWarn } from "../../logger.js";
import type { WorkerToolAuthority } from "../../worker/launch-descriptor.js";
import type { WorkerSessionPlacementIdentity } from "./placement-record.js";

type WorkerToolPreparationOptions = {
  preparedModelRuntime: NonNullable<
    Parameters<typeof createOpenClawCodingToolsInternalAsync>[0]
  >["preparedModelRuntime"];
  operationalRunInstance: NonNullable<
    Parameters<typeof createOpenClawCodingToolsInternalAsync>[0]
  >["operationalRunInstance"];
  githubPublicationAvailable: boolean;
  placementTools: AnyAgentTool[];
  adapters: AnyAgentTool[];
  launchToolNames: readonly string[];
  preparation: Parameters<typeof createOpenClawCodingToolsInternalAsync>[4];
};

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
  if (capabilityProfile.policy.delegatedToolPolicy) {
    // Worker-local tools do not carry the Gateway’s live delegation authority.
    // This gate also covers dispatch of existing sessions and required placement.
    throw new Error(
      "Worker execution cannot enforce a delegated tool grant. Run this session locally.",
    );
  }
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
    prepareTools: async (options: WorkerToolPreparationOptions) => {
      const availablePlacementTools = new Set(options.placementTools.map((tool) => tool.name));
      const prepared = await createOpenClawCodingToolsInternalAsync(
        {
          ...turn,
          authProfileStoreSource,
          agentId: params.placement.agentId,
          conversationCapabilityProfile: capabilityProfile,
          preparedModelRuntime: options.preparedModelRuntime,
          installedSkills,
          githubPublicationAvailable: options.githubPublicationAvailable,
          cronCreatorAuthorityUnavailableReason: undefined,
          runSessionKey: params.placement.sessionKey,
          sessionKey: turn.sandboxSessionKey ?? params.placement.sessionKey,
          policyAgentId: turn.sandboxAgentId ?? turn.agentId,
          operationalRunInstance: options.operationalRunInstance,
          sessionPermissionPolicy: turn.permissionMode
            ? { mode: turn.permissionMode, root: turn.workspaceDir }
            : undefined,
          modelProvider: params.modelRef.provider,
          modelId: params.modelRef.model,
          modelContextWindowTokens: corePolicy.modelContextWindowTokens,
          runtimeToolAllowlist: turn.toolsAllow,
          skillWorkshop: undefined,
          computerTransport: null,
        },
        undefined,
        undefined,
        { tools: [...options.placementTools, ...options.adapters], policy: corePolicy },
        options.preparation,
      );
      if (turn.disableTools || turn.modelRun || turn.promptMode === "none") {
        return [];
      }
      return applyEmbeddedAttemptToolsAllow(prepared, turn.toolsAllow).filter((tool) => {
        const location = getAgentToolExecutionLocation(tool);
        const reason =
          location.kind === "gateway"
            ? location.unavailableReason
            : !availablePlacementTools.has(tool.name) ||
                !options.launchToolNames.includes(tool.name)
              ? "the placement has no available execution capability"
              : undefined;
        if (reason) {
          logInfo(`Worker tool ${tool.name} withheld: ${reason}.`);
        }
        return !reason;
      });
    },
  };
}
