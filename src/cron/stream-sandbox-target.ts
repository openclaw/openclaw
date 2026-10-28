import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayAccessGrantRef } from "../plugins/gateway-access-policy.types.js";

/** Creator-owned logical target; physical process custody belongs to the sandbox registry. */
export type CronStreamSandboxTarget = {
  version: 1;
  backendId: "docker";
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision?: string;
  scopeKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  workspaceAccess: "none" | "ro" | "rw";
  containerWorkdir: string;
  workspaceSource?: "managed-worktree";
  configLabel: string;
  operator?: {
    profileId: string;
    scopes: string[];
    assignedRole: string | null;
    githubLogin: string | null;
    gatewayAccessGrant: GatewayAccessGrantRef | null;
  };
};

const TARGET_FIELDS = new Set([
  "version",
  "backendId",
  "agentId",
  "sessionKey",
  "sessionId",
  "lifecycleRevision",
  "scopeKey",
  "workspaceDir",
  "agentWorkspaceDir",
  "workspaceAccess",
  "containerWorkdir",
  "workspaceSource",
  "configLabel",
  "operator",
]);
const OPERATOR_FIELDS = new Set([
  "profileId",
  "scopes",
  "assignedRole",
  "githubLogin",
  "gatewayAccessGrant",
]);

function isTargetString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

/** Invalid or incomplete authority is never normalized into an unrestricted target. */
export function parseCronStreamSandboxTarget(value: unknown): CronStreamSandboxTarget | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !TARGET_FIELDS.has(key)) ||
    value.version !== 1 ||
    value.backendId !== "docker" ||
    !isTargetString(value.agentId) ||
    !isTargetString(value.sessionKey) ||
    !isTargetString(value.sessionId) ||
    (value.lifecycleRevision !== undefined && !isTargetString(value.lifecycleRevision)) ||
    !isTargetString(value.scopeKey) ||
    !isTargetString(value.workspaceDir) ||
    !isTargetString(value.agentWorkspaceDir) ||
    (value.workspaceAccess !== "none" &&
      value.workspaceAccess !== "ro" &&
      value.workspaceAccess !== "rw") ||
    !isTargetString(value.containerWorkdir) ||
    (value.workspaceSource !== undefined && value.workspaceSource !== "managed-worktree") ||
    !isTargetString(value.configLabel)
  ) {
    return undefined;
  }
  let operator: CronStreamSandboxTarget["operator"];
  if (value.operator !== undefined) {
    const input = value.operator;
    if (
      !isRecord(input) ||
      Object.keys(input).some((key) => !OPERATOR_FIELDS.has(key)) ||
      !isTargetString(input.profileId) ||
      !Array.isArray(input.scopes) ||
      !input.scopes.every(isTargetString) ||
      (input.assignedRole !== null && !isTargetString(input.assignedRole)) ||
      (input.githubLogin !== null && !isTargetString(input.githubLogin))
    ) {
      return undefined;
    }
    const grant = input.gatewayAccessGrant;
    let gatewayAccessGrant: GatewayAccessGrantRef | null = null;
    if (grant !== null) {
      if (
        !isRecord(grant) ||
        Object.keys(grant).some((key) => key !== "pluginId" && key !== "grantId") ||
        !isTargetString(grant.pluginId) ||
        !isTargetString(grant.grantId)
      ) {
        return undefined;
      }
      gatewayAccessGrant = { pluginId: grant.pluginId, grantId: grant.grantId };
    }
    operator = {
      profileId: input.profileId,
      scopes: [...input.scopes],
      assignedRole: input.assignedRole,
      githubLogin: input.githubLogin,
      gatewayAccessGrant,
    };
  }
  return {
    version: 1,
    backendId: "docker",
    agentId: value.agentId,
    sessionKey: value.sessionKey,
    sessionId: value.sessionId,
    ...(value.lifecycleRevision !== undefined
      ? { lifecycleRevision: value.lifecycleRevision }
      : {}),
    scopeKey: value.scopeKey,
    workspaceDir: value.workspaceDir,
    agentWorkspaceDir: value.agentWorkspaceDir,
    workspaceAccess: value.workspaceAccess,
    containerWorkdir: value.containerWorkdir,
    ...(value.workspaceSource !== undefined ? { workspaceSource: value.workspaceSource } : {}),
    configLabel: value.configLabel,
    ...(operator ? { operator } : {}),
  };
}
