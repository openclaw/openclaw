import type { OpenClawConfig } from "../../../config/config.js";
import { sanitizeForLog } from "../../../terminal/ansi.js";
import {
  collectDiscordNumericIdWarnings,
  scanDiscordNumericIdEntries,
} from "../providers/discord.js";
import {
  collectTelegramAllowFromUsernameWarnings,
  collectTelegramEmptyAllowlistExtraWarnings,
  scanTelegramAllowFromUsernameEntries,
} from "../providers/telegram.js";
import { scanEmptyAllowlistPolicyWarnings } from "./empty-allowlist-scan.js";
import {
  collectExecSafeBinCoverageWarnings,
  collectExecSafeBinTrustedDirHintWarnings,
  scanExecSafeBinCoverage,
  scanExecSafeBinTrustedDirHints,
} from "./exec-safe-bins.js";
import {
  collectLegacyToolsBySenderWarnings,
  scanLegacyToolsBySenderKeys,
} from "./legacy-tools-by-sender.js";
import {
  collectOpenPolicyAllowFromWarnings,
  maybeRepairOpenPolicyAllowFrom,
} from "./open-policy-allowfrom.js";

export function collectDoctorPreviewWarnings(params: {
  cfg: OpenClawConfig;
  doctorFixCommand: string;
}): string[] {
  const warnings: string[] = [];

  const telegramHits = scanTelegramAllowFromUsernameEntries(params.cfg);
  if (telegramHits.length > 0) {
    warnings.push(
      collectTelegramAllowFromUsernameWarnings({
        hits: telegramHits,
        doctorFixCommand: params.doctorFixCommand,
      }).join("\n"),
    );
  }

  const discordHits = scanDiscordNumericIdEntries(params.cfg);
  if (discordHits.length > 0) {
    warnings.push(
      collectDiscordNumericIdWarnings({
        hits: discordHits,
        doctorFixCommand: params.doctorFixCommand,
      }).join("\n"),
    );
  }

  const allowFromScan = maybeRepairOpenPolicyAllowFrom(params.cfg);
  if (allowFromScan.changes.length > 0) {
    warnings.push(
      collectOpenPolicyAllowFromWarnings({
        changes: allowFromScan.changes,
        doctorFixCommand: params.doctorFixCommand,
      }).join("\n"),
    );
  }

  const emptyAllowlistWarnings = scanEmptyAllowlistPolicyWarnings(params.cfg, {
    doctorFixCommand: params.doctorFixCommand,
    extraWarningsForAccount: collectTelegramEmptyAllowlistExtraWarnings,
  });
  if (emptyAllowlistWarnings.length > 0) {
    warnings.push(emptyAllowlistWarnings.map((line) => sanitizeForLog(line)).join("\n"));
  }

  const toolsBySenderHits = scanLegacyToolsBySenderKeys(params.cfg);
  if (toolsBySenderHits.length > 0) {
    warnings.push(
      collectLegacyToolsBySenderWarnings({
        hits: toolsBySenderHits,
        doctorFixCommand: params.doctorFixCommand,
      }).join("\n"),
    );
  }

  const safeBinCoverage = scanExecSafeBinCoverage(params.cfg);
  if (safeBinCoverage.length > 0) {
    warnings.push(
      collectExecSafeBinCoverageWarnings({
        hits: safeBinCoverage,
        doctorFixCommand: params.doctorFixCommand,
      }).join("\n"),
    );
  }

  const safeBinTrustedDirHints = scanExecSafeBinTrustedDirHints(params.cfg);
  if (safeBinTrustedDirHints.length > 0) {
    warnings.push(collectExecSafeBinTrustedDirHintWarnings(safeBinTrustedDirHints).join("\n"));
  }

  return warnings;
}
