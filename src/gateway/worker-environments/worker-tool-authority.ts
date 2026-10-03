import { resolveContextTokensForModel } from "../../agents/context.js";
import { resolveConversationCapabilityProfile } from "../../agents/conversation-capability-profile.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { resolveExecDefaults } from "../../agents/exec-defaults.js";
import { prepareCoreToolPolicy } from "../../agents/prepared-tool-surface.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import { resolveSandboxToolPolicyForAgent } from "../../agents/sandbox/tool-policy.js";
import { projectEffectiveExecPolicy } from "../../agents/session-permission-exec-mode.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { logWarn } from "../../logger.js";
import type { WorkerToolAuthority } from "../../worker/launch-descriptor.js";

export function resolveWorkerToolAuthority(params: {
  modelRef: { provider: string; model: string };
  turn: SessionPlacementTurnParams;
  computerAvailable?: boolean;
}) {
  const turn = params.turn;
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
    cfg: turn.config,
    sessionEntry: turn.execSession,
    execOverrides: turn.execOverrides,
    agentId: turn.agentId,
    sessionKey: turn.sandboxSessionKey?.trim() || turn.sessionKey?.trim() || turn.sessionId,
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
  const ask = policy.ask ?? defaults.ask;
  const node = configuredNode?.trim();
  const exec: NonNullable<WorkerToolAuthority["exec"]> = {
    security,
    ask,
    safeBins: [],
    ...(host === "node" ? { host, ...(node ? { node } : {}) } : { host }),
  };
  if (execUnavailable) {
    logWarn(
      "Worker exec/process withheld: captured exec policy requires local host or interactive approval. Run this turn locally.",
    );
  }
  return { capabilityProfile, policy: corePolicy, exec, execUnavailable };
}
