import type { WorkerToolSurface } from "../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import type { ExecApprovalTransport } from "../agents/bash-tools.exec-approval-request.js";
import { createCoreCodingTools } from "../agents/core-coding-tools.js";
import type { PreparedGitHubToolEnvironment } from "../agents/github-tool-identity.types.js";
import { projectEffectiveExecPolicy } from "../agents/session-permission-exec-mode.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SkillSnapshot } from "../skills/types.js";
import type { WorkerLaunchPlan, WorkerToolAuthority } from "./launch-descriptor.js";

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
  approvalTransport?: ExecApprovalTransport;
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
      // Definition-only construction cannot perform local Gateway RPC.
      nonInteractiveApproval: !params.approvalTransport,
      approvalTransport: params.approvalTransport,
      // Reviewer credentials and model configuration remain on the Gateway.
      autoReviewer: async () => ({
        decision: "ask",
        risk: "unknown",
        rationale: "Worker exec auto-review is unavailable; human approval is required.",
      }),
      approvalFollowupText: params.approvalTransport
        ? undefined
        : "Exec denied (approval_required): worker approval transport is unavailable. Reconnect this worker to an updated Gateway.",
      config: WORKER_TOOL_CONFIG,
      // The Gateway secret store is not delegated to the worker's scratch state.
      preparedStoreEnvironment: Object.freeze({}),
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
