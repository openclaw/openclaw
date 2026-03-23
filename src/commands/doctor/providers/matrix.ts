import { formatCliCommand } from "../../../cli/command-format.js";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  autoPrepareLegacyMatrixCrypto,
  detectLegacyMatrixCrypto,
} from "../../../infra/matrix-legacy-crypto.js";
import {
  autoMigrateLegacyMatrixState,
  detectLegacyMatrixState,
} from "../../../infra/matrix-legacy-state.js";
import {
  hasActionableMatrixMigration,
  hasPendingMatrixMigration,
  maybeCreateMatrixMigrationSnapshot,
} from "../../../infra/matrix-migration-snapshot.js";
import {
  detectPluginInstallPathIssue,
  formatPluginInstallPathIssue,
} from "../../../infra/plugin-install-path-warnings.js";
import { removePluginFromConfig } from "../../../plugins/uninstall.js";
import type { DoctorConfigMutationResult } from "../shared/config-mutation-state.js";

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

/**
 * Produces a config mutation that removes stale Matrix plugin install/load-path
 * references left behind by the old bundled-plugin layout.  When the install
 * record points to a path that no longer exists on disk the config entry blocks
 * validation, so removing it lets reinstall proceed cleanly.
 */
export async function cleanStaleMatrixPluginConfig(
  cfg: OpenClawConfig,
): Promise<DoctorConfigMutationResult> {
  const issue = await detectPluginInstallPathIssue({
    pluginId: "matrix",
    install: cfg.plugins?.installs?.matrix,
  });
  if (!issue || issue.kind !== "missing-path") {
    return { config: cfg, changes: [] };
  }
  const { config, actions } = removePluginFromConfig(cfg, "matrix");
  const removed: string[] = [];
  if (actions.install) {
    removed.push("install record");
  }
  if (actions.loadPath) {
    removed.push("load path");
  }
  if (actions.entry) {
    removed.push("plugin entry");
  }
  if (actions.allowlist) {
    removed.push("allowlist entry");
  }
  if (removed.length === 0) {
    return { config: cfg, changes: [] };
  }
  return {
    config,
    changes: [
      `Removed stale Matrix plugin references (${removed.join(", ")}). ` +
        `The previous install path no longer exists: ${issue.path}`,
    ],
  };
}

export async function applyMatrixDoctorRepair(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const pendingMatrixMigration = hasPendingMatrixMigration({
    cfg: params.cfg,
    env: params.env,
  });
  const actionableMatrixMigration = hasActionableMatrixMigration({
    cfg: params.cfg,
    env: params.env,
  });

  let matrixSnapshotReady = true;
  if (actionableMatrixMigration) {
    try {
      const snapshot = await maybeCreateMatrixMigrationSnapshot({
        trigger: "doctor-fix",
        env: params.env,
      });
      changes.push(
        `Matrix migration snapshot ${snapshot.created ? "created" : "reused"} before applying Matrix upgrades.\n- ${snapshot.archivePath}`,
      );
    } catch (err) {
      matrixSnapshotReady = false;
      warnings.push(`- Failed creating a Matrix migration snapshot before repair: ${String(err)}`);
      warnings.push(
        '- Skipping Matrix migration changes for now. Resolve the snapshot failure, then rerun "openclaw doctor --fix".',
      );
    }
  } else if (pendingMatrixMigration) {
    warnings.push(
      "- Matrix migration warnings are present, but no on-disk Matrix mutation is actionable yet. No pre-migration snapshot was needed.",
    );
  }

  if (!matrixSnapshotReady) {
    return { changes, warnings };
  }

  const matrixStateRepair = await autoMigrateLegacyMatrixState({
    cfg: params.cfg,
    env: params.env,
  });
  if (matrixStateRepair.changes.length > 0) {
    changes.push(
      [
        "Matrix plugin upgraded in place.",
        ...matrixStateRepair.changes.map((entry) => `- ${entry}`),
        "- No user action required.",
      ].join("\n"),
    );
  }
  if (matrixStateRepair.warnings.length > 0) {
    warnings.push(matrixStateRepair.warnings.map((entry) => `- ${entry}`).join("\n"));
  }

  const matrixCryptoRepair = await autoPrepareLegacyMatrixCrypto({
    cfg: params.cfg,
    env: params.env,
  });
  if (matrixCryptoRepair.changes.length > 0) {
    changes.push(
      [
        "Matrix encrypted-state migration prepared.",
        ...matrixCryptoRepair.changes.map((entry) => `- ${entry}`),
      ].join("\n"),
    );
  }
  if (matrixCryptoRepair.warnings.length > 0) {
    warnings.push(matrixCryptoRepair.warnings.map((entry) => `- ${entry}`).join("\n"));
  }

  return { changes, warnings };
}

export async function runMatrixDoctorSequence(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  shouldRepair: boolean;
}): Promise<{ changeNotes: string[]; warningNotes: string[] }> {
  const matrixLegacyState = detectLegacyMatrixState({
    cfg: params.cfg,
    env: params.env,
  });
  const matrixLegacyCrypto = detectLegacyMatrixCrypto({
    cfg: params.cfg,
    env: params.env,
  });
  const warningNotes: string[] = [];
  const changeNotes: string[] = [];

  if (params.shouldRepair) {
    const matrixRepair = await applyMatrixDoctorRepair({
      cfg: params.cfg,
      env: params.env,
    });
    changeNotes.push(...matrixRepair.changes);
    warningNotes.push(...matrixRepair.warnings);
  } else if (matrixLegacyState) {
    if ("warning" in matrixLegacyState) {
      warningNotes.push(`- ${matrixLegacyState.warning}`);
    } else {
      warningNotes.push(formatMatrixLegacyStatePreview(matrixLegacyState));
    }
  }

  if (
    !params.shouldRepair &&
    (matrixLegacyCrypto.warnings.length > 0 || matrixLegacyCrypto.plans.length > 0)
  ) {
    warningNotes.push(...formatMatrixLegacyCryptoPreview(matrixLegacyCrypto));
  }

  const matrixInstallWarnings = await collectMatrixInstallPathWarnings(params.cfg);
  if (matrixInstallWarnings.length > 0) {
    warningNotes.push(matrixInstallWarnings.join("\n"));
  }

  return { changeNotes, warningNotes };
}
