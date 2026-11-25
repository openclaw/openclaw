import { isConfigReadFailure } from "../config/io.invalid-config.js";
import { isPluginPackagingRuntimeOutputInvalidConfigSnapshot } from "../config/recovery-policy.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import { formatCliCommand } from "./command-format.js";

export function formatInvalidConfigRepairHint(
  snapshot: Pick<
    ConfigFileSnapshot,
    "valid" | "issues" | "warnings" | "legacyIssues" | "readError"
  >,
  doctorMessage: string,
): string {
  return isConfigReadFailure(snapshot)
    ? "Resolve the read error shown above, then retry."
    : isPluginPackagingRuntimeOutputInvalidConfigSnapshot(snapshot)
      ? formatPluginPackagingRuntimeOutputRecoveryHint()
      : `Run \`${formatCliCommand("openclaw doctor --fix")}\` ${doctorMessage}`;
}

export function formatInvalidConfigRecoveryHint(): string {
  return [
    `Run "${formatCliCommand("openclaw doctor --fix")}" to repair, then retry.`,
    "If startup is still blocked, inspect the adjacent .bak backup before restoring it manually.",
  ].join("\n");
}

export function formatPluginPackagingRuntimeOutputRecoveryHint(): string {
  return [
    "This is a plugin packaging issue, not a local config problem.",
    "Update or reinstall the plugin after the publisher ships compiled JavaScript, or disable/uninstall the plugin until then.",
  ].join("\n");
}
