import type { WorkerToolSurface } from "../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import type { ExecToolDefaults } from "../agents/bash-tools.exec-types.js";
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
  createApprovalTransport?: ExecToolDefaults["createApprovalTransport"];
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
      strictInlineEval: execAuthority.strictInlineEval,
      safeBins: execAuthority.safeBins ?? [],
      node: execAuthority.host === "node" ? execAuthority.node : undefined,
      createApprovalTransport: params.createApprovalTransport,
      autoReviewer: () => {
        throw new Error("Worker automatic review requires the Gateway approval transport");
      },
      // Definition preparation has no connection; it must never fall back to local RPC.
      nonInteractiveApproval: !params.createApprovalTransport,
      approvalFollowupText:
        "Worker exec approval is unavailable. Reconnect to an updated Gateway and retry.",
      config: WORKER_TOOL_CONFIG,
      // The Gateway secret store is not delegated to the worker's scratch state.
      preparedStoreEnvironment: {},
      // Synthetic worker keys have no lineage in the Gateway's session database.
      preparedSubagentExecution: false,
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
