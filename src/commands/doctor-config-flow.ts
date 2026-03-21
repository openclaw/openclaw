import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import { CONFIG_PATH, migrateLegacyConfig } from "../config/config.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { detectLegacyMatrixCrypto } from "../infra/matrix-legacy-crypto.js";
import { detectLegacyMatrixState } from "../infra/matrix-legacy-state.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import { note } from "../terminal/note.js";
import { noteOpencodeProviderOverrides, stripUnknownConfigKeys } from "./doctor-config-analysis.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { normalizeCompatibilityConfigValues } from "./doctor-legacy-config.js";
import type { DoctorOptions } from "./doctor-prompter.js";
import {
  collectDiscordNumericIdWarnings,
  maybeRepairDiscordNumericIds,
  scanDiscordNumericIdEntries,
} from "./doctor/providers/discord.js";
import {
  applyMatrixDoctorRepair,
  collectMatrixInstallPathWarnings,
  formatMatrixLegacyCryptoPreview,
  formatMatrixLegacyStatePreview,
} from "./doctor/providers/matrix.js";
import {
  collectTelegramAllowFromUsernameWarnings,
  collectTelegramEmptyAllowlistExtraWarnings,
  maybeRepairTelegramAllowFromUsernames,
  scanTelegramAllowFromUsernameEntries,
} from "./doctor/providers/telegram.js";
import { maybeRepairAllowlistPolicyAllowFrom } from "./doctor/shared/allowlist-policy-repair.js";
import { applyDoctorConfigMutation } from "./doctor/shared/config-mutation-state.js";
import {
  collectMissingDefaultAccountBindingWarnings,
  collectMissingExplicitDefaultAccountWarnings,
} from "./doctor/shared/default-account-warnings.js";
import { scanEmptyAllowlistPolicyWarnings } from "./doctor/shared/empty-allowlist-scan.js";
import {
  collectExecSafeBinCoverageWarnings,
  collectExecSafeBinTrustedDirHintWarnings,
  maybeRepairExecSafeBinProfiles,
  scanExecSafeBinCoverage,
  scanExecSafeBinTrustedDirHints,
} from "./doctor/shared/exec-safe-bins.js";
import {
  collectLegacyToolsBySenderWarnings,
  maybeRepairLegacyToolsBySenderKeys,
  scanLegacyToolsBySenderKeys,
} from "./doctor/shared/legacy-tools-by-sender.js";
import {
  collectMutableAllowlistWarnings,
  scanMutableAllowlistEntries,
} from "./doctor/shared/mutable-allowlist.js";
import {
  collectOpenPolicyAllowFromWarnings,
  maybeRepairOpenPolicyAllowFrom,
} from "./doctor/shared/open-policy-allowfrom.js";

export async function loadAndMaybeMigrateDoctorConfig(params: {
  options: DoctorOptions;
  confirm: (p: { message: string; initialValue: boolean }) => Promise<boolean>;
}) {
  const shouldRepair = params.options.repair === true || params.options.yes === true;
  const preflight = await runDoctorConfigPreflight();
  let snapshot = preflight.snapshot;
  const baseCfg = preflight.baseConfig;
  let cfg: OpenClawConfig = baseCfg;
  let candidate = structuredClone(baseCfg);
  let pendingChanges = false;
  let shouldWriteConfig = false;
  let fixHints: string[] = [];

  if (snapshot.legacyIssues.length > 0) {
    note(
      formatConfigIssueLines(snapshot.legacyIssues, "-").join("\n"),
      "Compatibility config keys detected",
    );
    const { config: migrated, changes } = migrateLegacyConfig(snapshot.parsed);
    if (changes.length > 0) {
      note(changes.join("\n"), "Doctor changes");
    }
    if (migrated) {
      candidate = migrated;
      pendingChanges = pendingChanges || changes.length > 0;
    }
    if (shouldRepair) {
      // Compatibility migration (2026-01-02, commit: 16420e5b) — normalize per-provider allowlists; move WhatsApp gating into channels.whatsapp.allowFrom.
      if (migrated) {
        cfg = migrated;
      }
    } else {
      fixHints.push(
        `Run "${formatCliCommand("openclaw doctor --fix")}" to apply compatibility migrations.`,
      );
    }
  }

  const normalized = normalizeCompatibilityConfigValues(candidate);
  if (normalized.changes.length > 0) {
    note(normalized.changes.join("\n"), "Doctor changes");
    ({ cfg, candidate, pendingChanges, fixHints } = applyDoctorConfigMutation({
      state: { cfg, candidate, pendingChanges, fixHints },
      mutation: normalized,
      shouldRepair,
      fixHint: `Run "${formatCliCommand("openclaw doctor --fix")}" to apply these changes.`,
    }));
  }

  const autoEnable = applyPluginAutoEnable({ config: candidate, env: process.env });
  if (autoEnable.changes.length > 0) {
    note(autoEnable.changes.join("\n"), "Doctor changes");
    ({ cfg, candidate, pendingChanges, fixHints } = applyDoctorConfigMutation({
      state: { cfg, candidate, pendingChanges, fixHints },
      mutation: autoEnable,
      shouldRepair,
      fixHint: `Run "${formatCliCommand("openclaw doctor --fix")}" to apply these changes.`,
    }));
  }

  const matrixLegacyState = detectLegacyMatrixState({
    cfg: candidate,
    env: process.env,
  });
  const matrixLegacyCrypto = detectLegacyMatrixCrypto({
    cfg: candidate,
    env: process.env,
  });
  if (shouldRepair) {
    const matrixRepair = await applyMatrixDoctorRepair({
      cfg: candidate,
      env: process.env,
    });
    for (const change of matrixRepair.changes) {
      note(change, "Doctor changes");
    }
    for (const warning of matrixRepair.warnings) {
      note(warning, "Doctor warnings");
    }
  } else if (matrixLegacyState) {
    if ("warning" in matrixLegacyState) {
      note(`- ${matrixLegacyState.warning}`, "Doctor warnings");
    } else {
      note(formatMatrixLegacyStatePreview(matrixLegacyState), "Doctor warnings");
    }
  }
  if (
    !shouldRepair &&
    (matrixLegacyCrypto.warnings.length > 0 || matrixLegacyCrypto.plans.length > 0)
  ) {
    for (const preview of formatMatrixLegacyCryptoPreview(matrixLegacyCrypto)) {
      note(preview, "Doctor warnings");
    }
  }

  const matrixInstallWarnings = await collectMatrixInstallPathWarnings(candidate);
  if (matrixInstallWarnings.length > 0) {
    note(matrixInstallWarnings.join("\n"), "Doctor warnings");
  }

  const missingDefaultAccountBindingWarnings =
    collectMissingDefaultAccountBindingWarnings(candidate);
  if (missingDefaultAccountBindingWarnings.length > 0) {
    note(missingDefaultAccountBindingWarnings.join("\n"), "Doctor warnings");
  }
  const missingExplicitDefaultWarnings = collectMissingExplicitDefaultAccountWarnings(candidate);
  if (missingExplicitDefaultWarnings.length > 0) {
    note(missingExplicitDefaultWarnings.join("\n"), "Doctor warnings");
  }

  if (shouldRepair) {
    const repair = await maybeRepairTelegramAllowFromUsernames(candidate);
    if (repair.changes.length > 0) {
      note(repair.changes.join("\n"), "Doctor changes");
      ({ cfg, candidate, pendingChanges, fixHints } = applyDoctorConfigMutation({
        state: { cfg, candidate, pendingChanges, fixHints },
        mutation: repair,
        shouldRepair,
      }));
    }

    const discordRepair = maybeRepairDiscordNumericIds(candidate);
    if (discordRepair.changes.length > 0) {
      note(discordRepair.changes.join("\n"), "Doctor changes");
      ({ cfg, candidate, pendingChanges, fixHints } = applyDoctorConfigMutation({
        state: { cfg, candidate, pendingChanges, fixHints },
        mutation: discordRepair,
        shouldRepair,
      }));
    }

    const allowFromRepair = maybeRepairOpenPolicyAllowFrom(candidate);
    if (allowFromRepair.changes.length > 0) {
      note(
        allowFromRepair.changes.map((line) => sanitizeForLog(line)).join("\n"),
        "Doctor changes",
      );
      ({ cfg, candidate, pendingChanges, fixHints } = applyDoctorConfigMutation({
        state: { cfg, candidate, pendingChanges, fixHints },
        mutation: allowFromRepair,
        shouldRepair,
      }));
    }

    const allowlistRepair = await maybeRepairAllowlistPolicyAllowFrom(candidate);
    if (allowlistRepair.changes.length > 0) {
      note(allowlistRepair.changes.join("\n"), "Doctor changes");
      ({ cfg, candidate, pendingChanges, fixHints } = applyDoctorConfigMutation({
        state: { cfg, candidate, pendingChanges, fixHints },
        mutation: allowlistRepair,
        shouldRepair,
      }));
    }

    const emptyAllowlistWarnings = scanEmptyAllowlistPolicyWarnings(candidate, {
      doctorFixCommand: formatCliCommand("openclaw doctor --fix"),
      extraWarningsForAccount: collectTelegramEmptyAllowlistExtraWarnings,
    });
    if (emptyAllowlistWarnings.length > 0) {
      note(
        emptyAllowlistWarnings.map((line) => sanitizeForLog(line)).join("\n"),
        "Doctor warnings",
      );
    }

    const toolsBySenderRepair = maybeRepairLegacyToolsBySenderKeys(candidate);
    if (toolsBySenderRepair.changes.length > 0) {
      note(toolsBySenderRepair.changes.join("\n"), "Doctor changes");
      ({ cfg, candidate, pendingChanges, fixHints } = applyDoctorConfigMutation({
        state: { cfg, candidate, pendingChanges, fixHints },
        mutation: toolsBySenderRepair,
        shouldRepair,
      }));
    }

    const safeBinProfileRepair = maybeRepairExecSafeBinProfiles(candidate);
    if (safeBinProfileRepair.changes.length > 0) {
      note(safeBinProfileRepair.changes.join("\n"), "Doctor changes");
      ({ cfg, candidate, pendingChanges, fixHints } = applyDoctorConfigMutation({
        state: { cfg, candidate, pendingChanges, fixHints },
        mutation: safeBinProfileRepair,
        shouldRepair,
      }));
    }
    if (safeBinProfileRepair.warnings.length > 0) {
      note(safeBinProfileRepair.warnings.join("\n"), "Doctor warnings");
    }
  } else {
    const hits = scanTelegramAllowFromUsernameEntries(candidate);
    if (hits.length > 0) {
      note(
        collectTelegramAllowFromUsernameWarnings({
          hits,
          doctorFixCommand: formatCliCommand("openclaw doctor --fix"),
        }).join("\n"),
        "Doctor warnings",
      );
    }

    const discordHits = scanDiscordNumericIdEntries(candidate);
    if (discordHits.length > 0) {
      note(
        collectDiscordNumericIdWarnings({
          hits: discordHits,
          doctorFixCommand: formatCliCommand("openclaw doctor --fix"),
        }).join("\n"),
        "Doctor warnings",
      );
    }

    const allowFromScan = maybeRepairOpenPolicyAllowFrom(candidate);
    if (allowFromScan.changes.length > 0) {
      note(
        collectOpenPolicyAllowFromWarnings({
          changes: allowFromScan.changes,
          doctorFixCommand: formatCliCommand("openclaw doctor --fix"),
        }).join("\n"),
        "Doctor warnings",
      );
    }

    const emptyAllowlistWarnings = scanEmptyAllowlistPolicyWarnings(candidate, {
      doctorFixCommand: formatCliCommand("openclaw doctor --fix"),
      extraWarningsForAccount: collectTelegramEmptyAllowlistExtraWarnings,
    });
    if (emptyAllowlistWarnings.length > 0) {
      note(
        emptyAllowlistWarnings.map((line) => sanitizeForLog(line)).join("\n"),
        "Doctor warnings",
      );
    }

    const toolsBySenderHits = scanLegacyToolsBySenderKeys(candidate);
    if (toolsBySenderHits.length > 0) {
      note(
        collectLegacyToolsBySenderWarnings({
          hits: toolsBySenderHits,
          doctorFixCommand: formatCliCommand("openclaw doctor --fix"),
        }).join("\n"),
        "Doctor warnings",
      );
    }

    const safeBinCoverage = scanExecSafeBinCoverage(candidate);
    if (safeBinCoverage.length > 0) {
      note(
        collectExecSafeBinCoverageWarnings({
          hits: safeBinCoverage,
          doctorFixCommand: formatCliCommand("openclaw doctor --fix"),
        }).join("\n"),
        "Doctor warnings",
      );
    }

    const safeBinTrustedDirHints = scanExecSafeBinTrustedDirHints(candidate);
    if (safeBinTrustedDirHints.length > 0) {
      note(
        collectExecSafeBinTrustedDirHintWarnings(safeBinTrustedDirHints).join("\n"),
        "Doctor warnings",
      );
    }
  }

  const mutableAllowlistHits = scanMutableAllowlistEntries(candidate);
  if (mutableAllowlistHits.length > 0) {
    note(collectMutableAllowlistWarnings(mutableAllowlistHits).join("\n"), "Doctor warnings");
  }

  const unknown = stripUnknownConfigKeys(candidate);
  if (unknown.removed.length > 0) {
    const lines = unknown.removed.map((path) => `- ${path}`).join("\n");
    candidate = unknown.config;
    pendingChanges = true;
    if (shouldRepair) {
      cfg = unknown.config;
      note(lines, "Doctor changes");
    } else {
      note(lines, "Unknown config keys");
      fixHints.push('Run "openclaw doctor --fix" to remove these keys.');
    }
  }

  if (!shouldRepair && pendingChanges) {
    const shouldApply = await params.confirm({
      message: "Apply recommended config repairs now?",
      initialValue: true,
    });
    if (shouldApply) {
      cfg = candidate;
      shouldWriteConfig = true;
    } else if (fixHints.length > 0) {
      note(fixHints.join("\n"), "Doctor");
    }
  }

  if (shouldRepair && pendingChanges) {
    shouldWriteConfig = true;
  }

  noteOpencodeProviderOverrides(cfg);

  return {
    cfg,
    path: snapshot.path ?? CONFIG_PATH,
    shouldWriteConfig,
    sourceConfigValid: snapshot.valid,
  };
}
