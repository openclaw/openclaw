import {
  listAgentEntries,
  listAgentIds,
  resolveAgentConfig,
} from "../agents/agent-scope-config.js";
import { resolveConfiguredToolPolicies } from "../agents/agent-tools.policy.js";
import { resolveExecDefaults } from "../agents/exec-defaults.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { isToolAllowedByPolicies } from "../agents/tool-policy-match.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentToolsConfig } from "../config/types.tools.js";
import type { ExecApprovalsFile } from "../infra/exec-approvals.js";

type AuditAgentToolContext = {
  label: string;
  agentId?: string;
  tools?: AgentToolsConfig;
};

export function listAuditAgentToolContexts(
  cfg: OpenClawConfig,
  agentIds?: ReadonlySet<string>,
): AuditAgentToolContext[] {
  const entries = listAgentEntries(cfg);
  if (agentIds) {
    return [...agentIds].map((agentId) => ({
      label: entries.some((entry) => entry.id === agentId)
        ? `agents.entries.${agentId}`
        : "agents.defaults",
      agentId,
      tools: resolveAgentConfig(cfg, agentId)?.tools,
    }));
  }
  return [
    { label: "agents.defaults" },
    ...entries.map((agent) => ({
      label: `agents.entries.${agent.id}`,
      agentId: agent.id,
      tools: agent.tools,
    })),
  ];
}

export function collectAuditAgentExecScopes(
  cfg: OpenClawConfig,
  approvals: ExecApprovalsFile,
  openInboundAgentIds?: ReadonlySet<string>,
) {
  const defaultsExec = cfg.tools?.exec;
  const scopes = listAgentIds(cfg).map((agentId) => {
    const tools = resolveAgentConfig(cfg, agentId)?.tools;
    const exec = tools?.exec;
    const sandboxMode = resolveSandboxConfigForAgent(cfg, agentId).mode;
    const resolved = resolveExecDefaults({
      cfg,
      agentId,
      // Non-main mode leaves each agent's main session on the host.
      sandboxAvailable: sandboxMode === "all",
      execApprovals: approvals,
    });
    const policies = resolveConfiguredToolPolicies({
      cfg,
      agentId,
      agentTools: tools,
      sandboxMode,
    });
    // Explicit full trust or switched-off approvals remains a posture finding,
    // even when no open ingress or available exec tool reaches this scope.
    const configured =
      (exec?.security ?? defaultsExec?.security) === "full" ||
      (exec?.mode ?? defaultsExec?.mode) === "full" ||
      (exec?.ask ?? defaultsExec?.ask) === "off";
    return {
      id: agentId,
      security: resolved.security,
      host: resolved.host,
      configured,
      toolAllowed: isToolAllowedByPolicies("exec", policies),
    };
  });
  const execEnabledScopes = scopes.filter(
    (entry) =>
      entry.security !== "deny" &&
      entry.toolAllowed &&
      (!openInboundAgentIds || openInboundAgentIds.has(entry.id)),
  );
  return {
    execEnabledScopes,
    configuredFullScopes: scopes.filter((entry) => entry.security === "full" && entry.configured),
    openFullExec: execEnabledScopes.some((entry) => entry.security === "full"),
  };
}
