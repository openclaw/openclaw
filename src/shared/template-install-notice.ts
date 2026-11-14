import { isRecord } from "@openclaw/normalization-core/record-coerce";

/** Installer facts, not recommendations or model-authored assistant content. */
export type TemplatePluginInstallNotice = {
  type: "template_plugin_install";
  pluginId: string;
  packageName: string;
  displayName: string;
  registryId?: string;
  iconUrl?: string;
  official?: boolean;
} & ({ status: "installed" } | { status: "error"; error?: string });

/** Read structured transcript receipts; never infer installation facts from assistant text. */
export function readTemplatePluginInstallNotice(
  value: unknown,
): TemplatePluginInstallNotice | undefined {
  if (
    !isRecord(value) ||
    value.type !== "template_plugin_install" ||
    !["pluginId", "packageName", "displayName"].every(
      (key) => typeof value[key] === "string" && value[key].trim().length > 0,
    ) ||
    (value.status !== "installed" && value.status !== "error") ||
    !["registryId", "iconUrl", "error"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    ) ||
    (value.official !== undefined && typeof value.official !== "boolean")
  ) {
    return undefined;
  }
  // SAFETY: every required and optional receipt field is validated above.
  return value as TemplatePluginInstallNotice;
}

export type TemplateInstallOutcome =
  | { kind: "plugin-install"; plugin: TemplatePluginInstallNotice }
  | {
      kind: "automation-created";
      declarationId: string;
      schedulerJobId: string;
      name: string;
      enabled: boolean;
    }
  | { kind: "automation-failed"; declarationId: string; name: string };

export type TemplateInstallEvent = TemplateInstallOutcome & {
  agentId: string;
  sessionKey: string;
};

export function formatTemplateInstallOutcome(outcome: TemplateInstallOutcome): string {
  if (outcome.kind === "plugin-install") {
    return outcome.plugin.status === "installed"
      ? `Plugin installed: ${outcome.plugin.displayName}.`
      : `Plugin installation failed: ${outcome.plugin.displayName}. Continue setup in this agent.`;
  }
  return outcome.kind === "automation-created"
    ? `Automation created: ${outcome.name}${outcome.enabled ? "." : " (paused until setup is ready)."}`
    : `Automation setup failed: ${outcome.name}. Continue setup in this agent.`;
}
