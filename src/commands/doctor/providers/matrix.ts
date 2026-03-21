import { formatCliCommand } from "../../../cli/command-format.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { detectLegacyMatrixCrypto } from "../../../infra/matrix-legacy-crypto.js";
import { detectLegacyMatrixState } from "../../../infra/matrix-legacy-state.js";
import {
  detectPluginInstallPathIssue,
  formatPluginInstallPathIssue,
} from "../../../infra/plugin-install-path-warnings.js";

export function formatMatrixLegacyStatePreview(
  detection: Exclude<ReturnType<typeof detectLegacyMatrixState>, null | { warning: string }>,
): string {
  return [
    "- Matrix plugin upgraded in place.",
    `- Legacy sync store: ${detection.legacyStoragePath} -> ${detection.targetStoragePath}`,
    `- Legacy crypto store: ${detection.legacyCryptoPath} -> ${detection.targetCryptoPath}`,
    ...(detection.selectionNote ? [`- ${detection.selectionNote}`] : []),
    '- Run "openclaw doctor --fix" to migrate this Matrix state now.',
  ].join("\n");
}

export function formatMatrixLegacyCryptoPreview(
  detection: ReturnType<typeof detectLegacyMatrixCrypto>,
): string[] {
  const notes: string[] = [];
  for (const warning of detection.warnings) {
    notes.push(`- ${warning}`);
  }
  for (const plan of detection.plans) {
    notes.push(
      [
        `- Matrix encrypted-state migration is pending for account "${plan.accountId}".`,
        `- Legacy crypto store: ${plan.legacyCryptoPath}`,
        `- New recovery key file: ${plan.recoveryKeyPath}`,
        `- Migration state file: ${plan.statePath}`,
        '- Run "openclaw doctor --fix" to extract any saved backup key now. Backed-up room keys will restore automatically on next gateway start.',
      ].join("\n"),
    );
  }
  return notes;
}

export async function collectMatrixInstallPathWarnings(cfg: OpenClawConfig): Promise<string[]> {
  const issue = await detectPluginInstallPathIssue({
    pluginId: "matrix",
    install: cfg.plugins?.installs?.matrix,
  });
  if (!issue) {
    return [];
  }
  return formatPluginInstallPathIssue({
    issue,
    pluginLabel: "Matrix",
    defaultInstallCommand: "openclaw plugins install @openclaw/matrix",
    repoInstallCommand: "openclaw plugins install ./extensions/matrix",
    formatCommand: formatCliCommand,
  }).map((entry) => `- ${entry}`);
}
