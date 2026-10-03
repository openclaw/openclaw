import { resolveContextTokensForModel } from "../../agents/context.js";
import { resolveConversationCapabilityProfile } from "../../agents/conversation-capability-profile.js";
import { projectConversationToolNames } from "../../agents/conversation-tool-policy-pipeline.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { applyEmbeddedAttemptToolsAllow } from "../../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { resolveExecDefaults } from "../../agents/exec-defaults.js";
import { prepareCoreToolPolicy } from "../../agents/prepared-tool-surface.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import { resolveSandboxToolPolicyForAgent } from "../../agents/sandbox/tool-policy.js";
import { projectEffectiveExecPolicy } from "../../agents/session-permission-exec-mode.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { logInfo, logWarn } from "../../logger.js";
import {
  WORKER_REQUIRED_LOCAL_TOOL_NAMES,
  WORKER_SESSION_TOOL_NAMES,
  type WorkerOptionalLocalToolName,
  type WorkerToolName,
  type WorkerToolAuthority,
} from "../../worker/tool-authority.js";

export function resolveWorkerToolAuthority(params: {
  modelRef: { provider: string; model: string };
  turn: SessionPlacementTurnParams;
  launchToolNames: readonly WorkerToolName[];
  availableOptionalToolNames?: readonly WorkerOptionalLocalToolName[];
  portalAvailable?: boolean;
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
          containedToolNames: params.availableOptionalToolNames?.includes("computer")
            ? ["computer"]
            : [],
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
  // Executable paths, safe-bin profiles, and command approvals are host-specific.
  // Until a portable allowlist exists, transmit an explicit empty safe-bin cap.
  const exec: NonNullable<WorkerToolAuthority["exec"]> = {
    security,
    ask,
    safeBins: [],
    ...(host === "node" ? { host, ...(node ? { node } : {}) } : { host }),
  };
  const runtimeCappedTools = applyEmbeddedAttemptToolsAllow(
    [
      ...WORKER_REQUIRED_LOCAL_TOOL_NAMES,
      ...(params.availableOptionalToolNames ?? []).filter(
        (name) => name !== "computer" || turn.modelHasVision !== false,
      ),
      ...WORKER_SESSION_TOOL_NAMES.filter((name) =>
        name === "skill_workshop"
          ? turn.skillLibraryAuthoring !== undefined
          : name !== "portal" || params.portalAvailable === true,
      ),
    ].map((name) => ({ name })),
    turn.toolsAllow,
  );
  const projected: WorkerToolName[] = projectConversationToolNames({
    capabilityProfile,
    toolNames: runtimeCappedTools.map((tool) => tool.name),
    warn: logWarn,
  });
  if (execUnavailable) {
    logWarn(
      "Worker exec/process withheld: captured exec policy requires local host or interactive approval. Run this turn locally.",
    );
  }
  const launchToolNames = new Set(params.launchToolNames);
  const withheld = projected.filter((name) => !launchToolNames.has(name));
  if (withheld.length > 0) {
    logInfo(
      `Worker tools withheld: the node's installed OpenClaw does not support ${withheld.join(", ")}. Update OpenClaw on the node and restart it to enable them.`,
    );
  }
  return {
    capabilityProfile,
    policy: corePolicy,
    toolAuthority: {
      allowedToolNames:
        turn.disableTools === true || turn.modelRun === true || turn.promptMode === "none"
          ? []
          : projected.filter(
              (name) =>
                launchToolNames.has(name) &&
                !(execUnavailable && (name === "exec" || name === "process")) &&
                !(corePolicy.readOnly && (name === "write" || name === "edit")) &&
                !(name === "apply_patch" && !corePolicy.applyPatchEnabled),
            ),
      exec,
    } satisfies WorkerToolAuthority,
  };
}
