import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  formatConcreteConfigPath,
  parseConcreteConfigPath,
  readObjectPath,
} from "../shared/dot-path.js";
import type { SystemAgentOperation } from "./operation-types.js";

/** Only host-authored explanations may be attached to an exact approval request. */
export class DelegatedChangeApprovalRequiredError extends Error {}

/** Permission edits cannot use the delegation grant they would broaden. */
export function describeDelegatedChangePolicyApproval(
  operation: SystemAgentOperation,
  config?: OpenClawConfig,
): string | undefined {
  if (
    operation.kind !== "config-set" &&
    operation.kind !== "config-unset" &&
    operation.kind !== "config-set-ref"
  ) {
    return undefined;
  }
  const path = parseConcreteConfigPath(operation.path);
  const grant =
    path[0] === "agents"
      ? ["agents", "entries", path[2], "tools", "openclaw", "autoApproveChanges"]
      : ["tools", "openclaw", "autoApproveChanges"];
  const overlaps = path
    .slice(0, Math.min(path.length, grant.length))
    .every((part, index) => part === grant[index]);
  if (!overlaps) {
    return undefined;
  }
  // A direct reduction is safe. Parent replacement or deletion can remove an
  // explicit false or introduce grants for other agents, so it needs a human.
  if (
    path.length === grant.length &&
    operation.kind === "config-set" &&
    operation.value.trim() === "false"
  ) {
    return undefined;
  }
  let detail =
    "This proposal may change tools.openclaw.autoApproveChanges or its per-agent overrides and future approval behavior. Review the proposed policy carefully; its resulting authority has not been established here.";
  let settingPath = "tools.openclaw.autoApproveChanges or the relevant per-agent override";
  if (path.length === grant.length) {
    settingPath = formatConcreteConfigPath(path);
    // Show only this boolean policy, never arbitrary config/SecretRef values.
    const current = config ? readObjectPath(config, path) : undefined;
    const previous =
      typeof current === "boolean"
        ? String(current)
        : current === undefined && config
          ? "unset"
          : undefined;
    if (operation.kind === "config-set" && operation.value.trim() === "true") {
      detail = previous
        ? `This proposal changes ${settingPath} from ${previous} to true.`
        : `This proposal sets ${settingPath} to true.`;
      detail +=
        " Approving saves standing authorization for future permitted delegated changes, including changes that can enable Gateway-host code execution.";
      if (path[0] === "tools") {
        detail += " Per-agent overrides still take precedence.";
      }
    } else if (operation.kind === "config-unset") {
      detail = `This proposal removes ${settingPath}${previous ? ` (currently ${previous})` : ""}.`;
      if (path[0] === "agents" && config) {
        const inherited = config.tools?.openclaw?.autoApproveChanges;
        detail +=
          inherited === undefined
            ? " This agent will inherit the global default: permitted changes may be automatic under Full Access."
            : ` This agent will inherit tools.openclaw.autoApproveChanges: ${inherited}. ${inherited ? "This supplies standing authorization for future permitted delegated changes, including changes that can enable Gateway-host code execution." : "This requires individual approval, including in Full Access."}`;
      } else {
        detail +=
          " Future automatic changes depend on Full Access and per-agent overrides; removing a setting does not necessarily disable automatic changes.";
      }
    }
  }
  return `${detail} Exact approval is required for this policy change. Approve this proposal, or edit ${settingPath} directly through operator configuration. To keep the current policy, deny this proposal. Containment, inherited authority, and operation limits still apply. See https://docs.openclaw.ai/gateway/permission-modes#delegated-setup-and-repair.`;
}
