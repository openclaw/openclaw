import fs from "node:fs/promises";
import path from "node:path";
import { normalizeChatChannelId } from "../channels/registry.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import { CONFIG_PATH } from "../config/config.js";
import { findLegacyConfigIssues } from "../config/legacy.js";
import { LEGACY_CONFIG_FILENAMES, resolveStateDir } from "../config/paths.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { listPluginDoctorLegacyConfigRules } from "../plugins/doctor-contract-registry.js";
import { note } from "../terminal/note.js";
import { noteOpencodeProviderOverrides } from "./doctor-config-analysis.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { normalizeCompatibilityConfigValues } from "./doctor-legacy-config.js";
import type { DoctorOptions } from "./doctor-prompter.js";
import { emitDoctorNotes } from "./doctor/emit-notes.js";
import { finalizeDoctorConfigFlow } from "./doctor/finalize-config-flow.js";
import { runDoctorRepairSequence } from "./doctor/repair-sequencing.js";
import {
  collectChannelDoctorMutableAllowlistWarnings,
  collectChannelDoctorStaleConfigMutations,
  runChannelDoctorConfigSequences,
} from "./doctor/shared/channel-doctor.js";
import {
  applyLegacyCompatibilityStep,
  applyUnknownConfigKeyStep,
} from "./doctor/shared/config-flow-steps.js";
import { applyDoctorConfigMutation } from "./doctor/shared/config-mutation-state.js";
import {
  collectMissingDefaultAccountBindingWarnings,
  collectMissingExplicitDefaultAccountWarnings,
} from "./doctor/shared/default-account-warnings.js";
import { collectDoctorPreviewWarnings } from "./doctor/shared/preview-warnings.js";

function hasLegacyInternalHookHandlers(raw: unknown): boolean {
  const handlers = (raw as { hooks?: { internal?: { handlers?: unknown } } })?.hooks?.internal
    ?.handlers;
  return Array.isArray(handlers) && handlers.length > 0;
}

/**
 * Rename stale legacy config files to `<name>.migrated` when `openclaw.json`
 * already exists in the same directory.  This prevents the gateway from
 * picking them up and producing validation-error log spam (issue #11465).
 */
export async function renameStaleLegacyConfigs(
  env: NodeJS.ProcessEnv = process.env,
  stateDir?: string,
): Promise<string[]> {
  const changes: string[] = [];
  const dir = stateDir ?? resolveStateDir(env);
  const primaryPath = path.join(dir, "openclaw.json");

  try {
    await fs.access(primaryPath);
  } catch {
    // openclaw.json doesn't exist — nothing to clean up
    return changes;
  }

  for (const legacyName of LEGACY_CONFIG_FILENAMES) {
    const legacyPath = path.join(dir, legacyName);
    try {
      await fs.access(legacyPath);
    } catch {
      continue;
    }
    const migratedPath = `${legacyPath}.migrated`;

    try {
      await fs.rename(legacyPath, migratedPath);
      changes.push(`Renamed stale legacy config: ${legacyPath} -> ${migratedPath}`);
    } catch (err) {
      // Log the specific error for debugging, but continue best-effort
      const errorMsg = err instanceof Error ? err.message : String(err);
      changes.push(`Failed to rename ${legacyPath}: ${errorMsg}`);
    }
  }

  return changes;
}

export async function loadAndMaybeMigrateDoctorConfig(params: {
  options: DoctorOptions;
  confirm: (p: { message: string; initialValue: boolean }) => Promise<boolean>;
}) {
  const shouldRepair = params.options.repair === true || params.options.yes === true;
  const preflight = await runDoctorConfigPreflight();
  let snapshot = preflight.snapshot;
  const baseCfg = preflight.baseConfig;

  const staleLegacyChanges = await renameStaleLegacyConfigs(process.env);
  if (staleLegacyChanges.length > 0) {
    note(staleLegacyChanges.map((entry) => `- ${entry}`).join("\n"), "Doctor changes");
  }
  let cfg: OpenClawConfig = baseCfg;
  let candidate = structuredClone(baseCfg);
  let pendingChanges = false;
  let fixHints: string[] = [];
  const doctorFixCommand = formatCliCommand("openclaw doctor --fix");

  const legacyStep = applyLegacyCompatibilityStep({
    snapshot,
    state: { cfg, candidate, pendingChanges, fixHints },
    shouldRepair,
    doctorFixCommand,
  });
  ({ cfg, candidate, pendingChanges, fixHints } = legacyStep.state);
  const pluginLegacyIssues = findLegacyConfigIssues(
    snapshot.parsed,
    snapshot.parsed,
    listPluginDoctorLegacyConfigRules(),
  );
  const seenLegacyIssues = new Set(
    snapshot.legacyIssues.map((issue) => `${issue.path}:${issue.message}`),
  );
  const pluginIssueLines = pluginLegacyIssues
    .filter((issue) => {
      const key = `${issue.path}:${issue.message}`;
      if (seenLegacyIssues.has(key)) {
        return false;
      }
      seenLegacyIssues.add(key);
      return true;
    })
    .map((issue) => `- ${issue.path}: ${issue.message}`);
  const legacyIssueLines = [...legacyStep.issueLines, ...pluginIssueLines];
  if (
    pluginIssueLines.length > 0 &&
    !shouldRepair &&
    !fixHints.includes(`Run "${doctorFixCommand}" to migrate legacy config keys.`)
  ) {
    fixHints = [...fixHints, `Run "${doctorFixCommand}" to migrate legacy config keys.`];
  }
  if (legacyIssueLines.length > 0) {
    note(legacyIssueLines.join("\n"), "Legacy config keys detected");
  }
  if (legacyStep.changeLines.length > 0) {
    note(legacyStep.changeLines.join("\n"), "Doctor changes");
  }
  if (hasLegacyInternalHookHandlers(snapshot.parsed)) {
    note(
      [
        "- hooks.internal.handlers: legacy inline hook modules are no longer part of the public config surface.",
        "- Migrate each entry to a managed or workspace hook directory with HOOK.md + handler.js, then enable it through hooks.internal.entries.<hookKey> as needed.",
        "- openclaw doctor --fix does not rewrite this shape automatically.",
      ].join("\n"),
      "Legacy config keys detected",
    );
  }

  const normalized = normalizeCompatibilityConfigValues(candidate);
  if (normalized.changes.length > 0) {
    note(normalized.changes.join("\n"), "Doctor changes");
    ({ cfg, candidate, pendingChanges, fixHints } = applyDoctorConfigMutation({
      state: { cfg, candidate, pendingChanges, fixHints },
      mutation: normalized,
      shouldRepair,
      fixHint: `Run "${doctorFixCommand}" to apply these changes.`,
    }));
  }

  const autoEnable = applyPluginAutoEnable({ config: candidate, env: process.env });
  if (autoEnable.changes.length > 0) {
    note(autoEnable.changes.join("\n"), "Doctor changes");
    ({ cfg, candidate, pendingChanges, fixHints } = applyDoctorConfigMutation({
      state: { cfg, candidate, pendingChanges, fixHints },
      mutation: autoEnable,
      shouldRepair,
      fixHint: `Run "${doctorFixCommand}" to apply these changes.`,
    }));
  }

  const channelDoctorSequence = await runChannelDoctorConfigSequences({
    cfg: candidate,
    env: process.env,
    shouldRepair,
  });
  emitDoctorNotes({
    note,
    changeNotes: channelDoctorSequence.changeNotes,
    warningNotes: channelDoctorSequence.warningNotes,
  });

  for (const staleCleanup of await collectChannelDoctorStaleConfigMutations(candidate)) {
    if (staleCleanup.changes.length === 0) {
      continue;
    }
    note(staleCleanup.changes.join("\n"), "Doctor changes");
    ({ cfg, candidate, pendingChanges, fixHints } = applyDoctorConfigMutation({
      state: { cfg, candidate, pendingChanges, fixHints },
      mutation: staleCleanup,
      shouldRepair,
      fixHint: `Run "${doctorFixCommand}" to remove stale channel plugin references.`,
    }));
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
    const repairSequence = await runDoctorRepairSequence({
      state: { cfg, candidate, pendingChanges, fixHints },
      doctorFixCommand,
    });
    ({ cfg, candidate, pendingChanges, fixHints } = repairSequence.state);
    emitDoctorNotes({
      note,
      changeNotes: repairSequence.changeNotes,
      warningNotes: repairSequence.warningNotes,
    });
  } else {
    emitDoctorNotes({
      note,
      warningNotes: await collectDoctorPreviewWarnings({
        cfg: candidate,
        doctorFixCommand,
      }),
    });
  }

  const mutableAllowlistWarnings = await collectChannelDoctorMutableAllowlistWarnings({
    cfg: candidate,
  });
  if (mutableAllowlistWarnings.length > 0) {
    note(mutableAllowlistWarnings.join("\n"), "Doctor warnings");
  }

  const unknownStep = applyUnknownConfigKeyStep({
    state: { cfg, candidate, pendingChanges, fixHints },
    shouldRepair,
    doctorFixCommand,
  });
  ({ cfg, candidate, pendingChanges, fixHints } = unknownStep.state);
  if (unknownStep.removed.length > 0) {
    const lines = unknownStep.removed.map((path) => `- ${path}`).join("\n");
    note(lines, shouldRepair ? "Doctor changes" : "Unknown config keys");
  }

  const finalized = await finalizeDoctorConfigFlow({
    cfg,
    candidate,
    pendingChanges,
    shouldRepair,
    fixHints,
    confirm: params.confirm,
    note,
  });
  cfg = finalized.cfg;

  noteOpencodeProviderOverrides(cfg);

  return {
    cfg,
    path: snapshot.path ?? CONFIG_PATH,
    shouldWriteConfig: finalized.shouldWriteConfig,
    sourceConfigValid: snapshot.valid,
  };
}
