import { listAgentEntries, resolveAgentConfig } from "../agents/agent-scope-config.js";
import { resolveConfiguredToolPolicies } from "../agents/agent-tools.policy.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { isToolAllowedByPolicies } from "../agents/tool-policy-match.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentToolsConfig } from "../config/types.tools.js";
import { listPotentialRouteAgentIds } from "../routing/resolve-route.js";
import { GATEWAY_CONTROL_PLANE_TOOLS } from "./dangerous-tools.js";

type AuditAgentToolContext = {
  label: string;
  agentId?: string;
  tools?: AgentToolsConfig;
};

export function listAuditAgentToolContexts(cfg: OpenClawConfig): AuditAgentToolContext[] {
  const contexts: AuditAgentToolContext[] = [{ label: "agents.defaults" }];
  for (const agent of listAgentEntries(cfg)) {
    if (!agent || typeof agent !== "object" || typeof agent.id !== "string") {
      continue;
    }
    contexts.push({
      label: `agents.entries.${agent.id}`,
      agentId: agent.id,
      tools: agent.tools,
    });
  }
  return contexts;
}

export function collectToolExposureContexts(
  cfg: OpenClawConfig,
  contexts = listAuditAgentToolContexts(cfg),
): {
  riskyContexts: string[];
  hasRuntimeRisk: boolean;
  controlPlaneContexts: string[];
} {
  const riskyContexts: string[] = [];
  const controlPlaneContexts: string[] = [];
  let hasRuntimeRisk = false;
  for (const context of contexts) {
    const sandboxMode = resolveSandboxConfigForAgent(cfg, context.agentId).mode;
    const policies = resolveConfiguredToolPolicies({
      cfg,
      agentTools: context.tools,
      sandboxMode,
      agentId: context.agentId ?? null,
    });
    const controlPlaneTools = GATEWAY_CONTROL_PLANE_TOOLS.filter((tool) =>
      isToolAllowedByPolicies(tool, policies),
    );
    if (controlPlaneTools.length > 0) {
      const profile = context.tools?.profile ?? cfg.tools?.profile ?? "none";
      controlPlaneContexts.push(
        `${context.label} (profile=${profile}; controlPlane=[${controlPlaneTools.join(", ")}])`,
      );
    }
    const runtimeTools = ["exec", "process"].filter((tool) =>
      isToolAllowedByPolicies(tool, policies),
    );
    const fsTools = ["read", "write", "edit", "apply_patch"].filter((tool) =>
      isToolAllowedByPolicies(tool, policies),
    );
    const fsWorkspaceOnly = context.tools?.fs?.workspaceOnly ?? cfg.tools?.fs?.workspaceOnly;
    const runtimeUnguarded = runtimeTools.length > 0 && sandboxMode !== "all";
    const fsUnguarded = fsTools.length > 0 && sandboxMode !== "all" && fsWorkspaceOnly !== true;
    if (!runtimeUnguarded && !fsUnguarded) {
      continue;
    }
    if (runtimeUnguarded) {
      hasRuntimeRisk = true;
    }
    riskyContexts.push(
      `${context.label} (sandbox=${sandboxMode}; runtime=[${runtimeTools.join(", ") || "off"}]; fs=[${fsTools.join(", ") || "off"}]; fs.workspaceOnly=${
        fsWorkspaceOnly === true ? "true" : "false"
      })`,
    );
  }

  return { riskyContexts, hasRuntimeRisk, controlPlaneContexts };
}

/** Undefined retains the all-agents audit when ingress ownership is unresolved. */
export function resolveExposureAgentIds(
  cfg: OpenClawConfig,
  policyPaths: readonly string[],
): string[] | undefined {
  // Broadcast participants bypass single-agent channel routing.
  if (cfg.broadcast && Object.keys(cfg.broadcast).some((key) => key !== "strategy")) {
    return undefined;
  }
  const agentIds = new Set<string>();
  try {
    for (const path of policyPaths) {
      const match =
        /^channels\.([^.]+)\.(?:accounts\.([^.]+)\.)?(?:dmPolicy|groupPolicy|dm\.policy)$/.exec(
          path,
        );
      if (!match) {
        return undefined;
      }
      const channel = match[1]!;
      if (channel === "defaults") {
        return undefined;
      }
      const config = cfg.channels?.[channel];
      if (!config || typeof config !== "object") {
        return undefined;
      }
      const accounts = match[2]
        ? [match[2]]
        : [
            ...new Set([
              "default",
              ...(typeof config.defaultAccount === "string" ? [config.defaultAccount] : []),
              ...Object.keys(config.accounts ?? {}),
            ]),
          ];
      for (const accountId of accounts) {
        for (const agentId of listPotentialRouteAgentIds({ cfg, channel, accountId })) {
          // An implicit runtime agent has global/default policy, not an entry to narrow to.
          if (!resolveAgentConfig(cfg, agentId)) {
            return undefined;
          }
          agentIds.add(agentId);
        }
      }
    }
  } catch {
    return undefined;
  }
  return [...agentIds];
}
