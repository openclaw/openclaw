/**
 * Tool filesystem policy resolver.
 *
 * Combines global and agent fs/tool policy into workspace-only and root-expansion decisions.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { isApplyPatchAllowedForModel } from "./apply-patch-policy.js";
import type { DelegatedFileToolRestriction } from "./inherited-tool-parameters.types.js";
import { pickSandboxToolPolicy } from "./sandbox-tool-policy.js";
import { isToolAllowedByPolicies } from "./tool-policy-match.js";
import { mergeAlsoAllowPolicy, resolveToolProfilePolicy } from "./tool-policy.js";

export type { PreparedSessionPermissionPolicy, ToolFsPolicy } from "./tool-fs-policy.types.js";
export { resolveSessionPermissionExecMode } from "./session-permission-exec-mode.js";

export function resolveToolFsConfig(params: { cfg?: OpenClawConfig; agentId?: string }): {
  workspaceOnly?: boolean;
} {
  const cfg = params.cfg;
  const globalFs = cfg?.tools?.fs;
  const agentFs =
    cfg && params.agentId ? resolveAgentConfig(cfg, params.agentId)?.tools?.fs : undefined;
  return {
    workspaceOnly: agentFs?.workspaceOnly ?? globalFs?.workspaceOnly,
  };
}

export function resolveEffectiveToolFsWorkspaceOnly(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): boolean {
  return resolveToolFsConfig(params).workspaceOnly === true;
}

export function resolveEffectiveToolFsRootExpansionAllowed(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  workspaceOnly?: boolean;
}): boolean {
  if ((params.workspaceOnly ?? resolveToolFsConfig(params).workspaceOnly) === true) {
    return false;
  }
  const cfg = params.cfg;
  if (!cfg) {
    return true;
  }
  const agentTools = params.agentId ? resolveAgentConfig(cfg, params.agentId)?.tools : undefined;
  const globalTools = cfg.tools;
  const profile = agentTools?.profile ?? globalTools?.profile;
  const profileAlsoAllow = new Set(agentTools?.alsoAllow ?? globalTools?.alsoAllow ?? []);
  // tools.fs presence does not grant access; require profile or alsoAllow (#47487).
  const profilePolicy = mergeAlsoAllowPolicy(
    resolveToolProfilePolicy(profile),
    profileAlsoAllow.size > 0 ? Array.from(profileAlsoAllow) : undefined,
  );
  const globalPolicy = pickSandboxToolPolicy(globalTools);
  const agentPolicy = pickSandboxToolPolicy(agentTools);
  return isToolAllowedByPolicies("read", [profilePolicy, globalPolicy, agentPolicy]);
}

/** Capture configured patch eligibility, not eligibility for the source's current model. */
export function captureDelegatedFileToolRestriction(params: {
  workspaceOnly: boolean;
  readOnly: boolean;
  applyPatchWorkspaceOnly: boolean;
  configuredApplyPatchEnabled: boolean;
  applyPatchAllowModels?: readonly string[] | null;
}): DelegatedFileToolRestriction {
  return {
    workspaceOnly: params.workspaceOnly,
    readOnly: params.readOnly,
    applyPatchEnabled: params.configuredApplyPatchEnabled,
    applyPatchWorkspaceOnly: params.applyPatchWorkspaceOnly,
    applyPatchAllowModels: params.applyPatchAllowModels?.length
      ? [
          ...new Set(
            params.applyPatchAllowModels.map((value) => value.trim().toLowerCase()).filter(Boolean),
          ),
        ].toSorted()
      : null,
  };
}

/** Apply each predicate to the receiver's admitted workspace and current model. */
export function applyDelegatedFileToolRestrictions(params: {
  restrictions: readonly DelegatedFileToolRestriction[];
  workspaceOnly: boolean;
  readOnly: boolean;
  applyPatchEnabled: boolean;
  applyPatchWorkspaceOnly: boolean;
  modelProvider?: string;
  modelId?: string;
}) {
  const readOnly = params.readOnly || params.restrictions.some((entry) => entry.readOnly);
  const workspaceOnly =
    params.workspaceOnly || params.restrictions.some((entry) => entry.workspaceOnly);
  return {
    workspaceOnly,
    readOnly,
    applyPatchWorkspaceOnly:
      workspaceOnly ||
      params.applyPatchWorkspaceOnly ||
      params.restrictions.some((entry) => entry.applyPatchWorkspaceOnly),
    applyPatchEnabled:
      params.applyPatchEnabled &&
      !readOnly &&
      params.restrictions.every(
        (entry) =>
          entry.applyPatchEnabled &&
          (entry.applyPatchAllowModels === null || entry.applyPatchAllowModels.length > 0) &&
          isApplyPatchAllowedForModel({
            modelProvider: params.modelProvider,
            modelId: params.modelId,
            allowModels: entry.applyPatchAllowModels ?? undefined,
          }),
      ),
  };
}
