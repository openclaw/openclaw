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
    typeof value.pluginId !== "string" ||
    !value.pluginId.trim() ||
    typeof value.packageName !== "string" ||
    !value.packageName.trim() ||
    typeof value.displayName !== "string" ||
    !value.displayName.trim() ||
    (value.status !== "installed" && value.status !== "error")
  ) {
    return undefined;
  }
  return {
    type: "template_plugin_install",
    pluginId: value.pluginId,
    packageName: value.packageName,
    displayName: value.displayName,
    ...(typeof value.registryId === "string" ? { registryId: value.registryId } : {}),
    ...(typeof value.iconUrl === "string" ? { iconUrl: value.iconUrl } : {}),
    ...(typeof value.official === "boolean" ? { official: value.official } : {}),
    ...(value.status === "error"
      ? { status: "error", ...(typeof value.error === "string" ? { error: value.error } : {}) }
      : { status: "installed" }),
  };
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
