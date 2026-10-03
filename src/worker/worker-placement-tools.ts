import type { WorkerToolSurface } from "../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import { createCoreCodingTools } from "../agents/core-coding-tools.js";
import type { PreparedGitHubToolEnvironment } from "../agents/github-tool-identity.types.js";
import { projectEffectiveExecPolicy } from "../agents/session-permission-exec-mode.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SkillSnapshot } from "../skills/types.js";
import type { WorkerLaunchPlan } from "./launch-descriptor.js";
import type { WorkerToolAuthority } from "./tool-authority.js";

export const WORKER_TOOL_CONFIG = { plugins: { enabled: false } } satisfies OpenClawConfig;

/** Gateway definition preparation and placement execution use the same constructors. */
export function createWorkerPlacementTools(params: {
  policy: WorkerToolSurface["policy"];
  cwd: string;
  containmentRoot: string;
  execAuthority: WorkerToolAuthority["exec"];
  permissionMode?: WorkerLaunchPlan["assignment"]["permissionMode"];
  agentId: string;
  sessionKey: string;
  sessionId: string;
  runId: string;
  github?: PreparedGitHubToolEnvironment;
  skillsSnapshot?: SkillSnapshot;
}) {
  // Workers have no node/sandbox execution transport; host approval grants are not portable.
  const execUnavailable =
    params.execAuthority === undefined ||
    params.execAuthority.host === "sandbox" ||
    params.execAuthority.host === "node";
  const execAuthority = params.execAuthority ?? {
    host: "gateway" as const,
    security: "deny" as const,
    ask: "off" as const,
  };
  const policy = projectEffectiveExecPolicy({
    base: execAuthority,
    overrides: execAuthority,
    permissionPolicy: params.permissionMode ? { mode: params.permissionMode } : undefined,
  });
  return createCoreCodingTools({
    ...params.policy,
    skillsSnapshot: params.skillsSnapshot,
    codingRoot: params.cwd,
    containmentRoot: params.containmentRoot,
    includeBaseCodingTools: true,
    shellTools: execUnavailable ? "patch-only" : "full",
    execDefaults: {
      ...policy,
      safeBins: execAuthority.safeBins ?? [],
      node: execAuthority.host === "node" ? execAuthority.node : undefined,
      // Worker LLM review and interactive approval transport remain a separate contract.
      nonInteractiveApproval: Boolean(params.permissionMode && params.permissionMode !== "full"),
      approvalFollowupText: params.permissionMode
        ? `Exec denied (approval_required) in worker ${params.permissionMode} permission mode. Run this command locally for interactive approval, or ask an administrator to clear the session permission mode.`
        : undefined,
      config: WORKER_TOOL_CONFIG,
      ...(params.github ? { preparedRunEnvironment: params.github } : {}),
      commandHighlighting: false,
      agentId: params.agentId,
      allowBackground: true,
      scopeKey: params.sessionKey,
      sessionKey: params.sessionKey,
      runId: params.runId,
      notifySessionKey: params.sessionKey,
      sessionId: params.sessionId,
      eventRouting: { preserveSessionKey: false },
    },
    processDefaults: { scopeKey: params.sessionKey },
  });
}
