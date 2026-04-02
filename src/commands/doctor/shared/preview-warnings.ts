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
import {
  collectBundledPluginLoadPathWarnings,
  scanBundledPluginLoadPathMigrations,
} from "./bundled-plugin-load-paths.js";
import {
  collectConfiguredChannelPluginBlockerWarnings,
  isWarningBlockedByChannelPlugin,
  scanConfiguredChannelPluginBlockers,
} from "./channel-plugin-blockers.js";
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
import {
  collectStalePluginConfigWarnings,
  isStalePluginAutoRepairBlocked,
  scanStalePluginConfig,
} from "./stale-plugin-config.js";

export function collectDoctorPreviewWarnings(params: {
  cfg: OpenClawConfig;
  doctorFixCommand: string;
}): string[] {
  const warnings: string[] = [];

  const channelPluginBlockerHits = scanConfiguredChannelPluginBlockers(params.cfg, process.env);
  if (channelPluginBlockerHits.length > 0) {
    warnings.push(
      collectConfiguredChannelPluginBlockerWarnings(channelPluginBlockerHits).join("\n"),
    );
  }

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

  const stalePluginHits = scanStalePluginConfig(params.cfg, process.env);
  if (stalePluginHits.length > 0) {
    warnings.push(
      collectStalePluginConfigWarnings({
        hits: stalePluginHits,
        doctorFixCommand: params.doctorFixCommand,
        autoRepairBlocked: isStalePluginAutoRepairBlocked(params.cfg, process.env),
      }).join("\n"),
    );
  }

  const bundledPluginLoadPathHits = scanBundledPluginLoadPathMigrations(params.cfg, process.env);
  if (bundledPluginLoadPathHits.length > 0) {
    warnings.push(
      collectBundledPluginLoadPathWarnings({
        hits: bundledPluginLoadPathHits,
        doctorFixCommand: params.doctorFixCommand,
      }).join("\n"),
    );
  }

  const emptyAllowlistWarnings = scanEmptyAllowlistPolicyWarnings(params.cfg, {
    doctorFixCommand: params.doctorFixCommand,
    extraWarningsForAccount: collectTelegramEmptyAllowlistExtraWarnings,
  }).filter((warning) => !isWarningBlockedByChannelPlugin(warning, channelPluginBlockerHits));
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
