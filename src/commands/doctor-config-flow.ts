import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import { CONFIG_PATH } from "../config/config.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { note } from "../terminal/note.js";
import { noteOpencodeProviderOverrides } from "./doctor-config-analysis.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { normalizeCompatibilityConfigValues } from "./doctor-legacy-config.js";
import type { DoctorOptions } from "./doctor-prompter.js";
import { emitDoctorNotes } from "./doctor/emit-notes.js";
import { finalizeDoctorConfigFlow } from "./doctor/finalize-config-flow.js";
import {
  cleanStaleMatrixPluginConfig,
  runMatrixDoctorSequence,
} from "./doctor/providers/matrix.js";
import { runDoctorRepairSequence } from "./doctor/repair-sequencing.js";
import {
  applyLegacyCompatibilityStep,
  applyUnknownConfigKeyStep,
} from "./doctor/shared/config-flow-steps.js";
import { applyDoctorConfigMutation } from "./doctor/shared/config-mutation-state.js";
import {
  collectMissingDefaultAccountBindingWarnings,
  collectMissingExplicitDefaultAccountWarnings,
} from "./doctor/shared/default-account-warnings.js";
import {
  collectMutableAllowlistWarnings,
  scanMutableAllowlistEntries,
} from "./doctor/shared/mutable-allowlist.js";
import { collectDoctorPreviewWarnings } from "./doctor/shared/preview-warnings.js";

const doctorDebugEnabled = () => process.env.OPENCLAW_DEBUG_DOCTOR === "1";
const debugDoctor = (message: string) => {
  if (!doctorDebugEnabled()) {
    return;
  }
  process.stderr.write(`[doctor:debug] ${message}\n`);
};

export async function loadAndMaybeMigrateDoctorConfig(params: {
  options: DoctorOptions;
  confirm: (p: { message: string; initialValue: boolean }) => Promise<boolean>;
}) {
  const shouldRepair = params.options.repair === true || params.options.yes === true;
  debugDoctor("doctor-config-flow:preflight:start");
  const preflight = await runDoctorConfigPreflight();
  debugDoctor("doctor-config-flow:preflight:done");
  let snapshot = preflight.snapshot;
  const baseCfg = preflight.baseConfig;
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
  if (legacyStep.issueLines.length > 0) {
    note(legacyStep.issueLines.join("\n"), "Compatibility config keys detected");
  }
  if (legacyStep.changeLines.length > 0) {
    note(legacyStep.changeLines.join("\n"), "Doctor changes");
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

  const matrixSequence = await runMatrixDoctorSequence({
    cfg: candidate,
    env: process.env,
    shouldRepair,
  });
  debugDoctor("doctor-config-flow:runMatrixDoctorSequence:done");
  emitDoctorNotes({
    note,
    changeNotes: matrixSequence.changeNotes,
    warningNotes: matrixSequence.warningNotes,
  });

  debugDoctor("doctor-config-flow:cleanStaleMatrixPluginConfig:start");
  const staleMatrixCleanup = await cleanStaleMatrixPluginConfig(candidate);
  debugDoctor("doctor-config-flow:cleanStaleMatrixPluginConfig:done");
  if (staleMatrixCleanup.changes.length > 0) {
    note(staleMatrixCleanup.changes.join("\n"), "Doctor changes");
    ({ cfg, candidate, pendingChanges, fixHints } = applyDoctorConfigMutation({
      state: { cfg, candidate, pendingChanges, fixHints },
      mutation: staleMatrixCleanup,
      shouldRepair,
      fixHint: `Run "${doctorFixCommand}" to remove stale Matrix plugin references.`,
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
    debugDoctor("doctor-config-flow:runDoctorRepairSequence:start");
    const repairSequence = await runDoctorRepairSequence({
      state: { cfg, candidate, pendingChanges, fixHints },
      doctorFixCommand,
    });
    debugDoctor("doctor-config-flow:runDoctorRepairSequence:done");
    ({ cfg, candidate, pendingChanges, fixHints } = repairSequence.state);
    emitDoctorNotes({
      note,
      changeNotes: repairSequence.changeNotes,
      warningNotes: repairSequence.warningNotes,
    });
  } else {
    emitDoctorNotes({
      note,
      warningNotes: collectDoctorPreviewWarnings({
        cfg: candidate,
        doctorFixCommand,
      }),
    });
  }

  const mutableAllowlistHits = scanMutableAllowlistEntries(candidate);
  if (mutableAllowlistHits.length > 0) {
    note(collectMutableAllowlistWarnings(mutableAllowlistHits).join("\n"), "Doctor warnings");
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

  debugDoctor("doctor-config-flow:finalizeDoctorConfigFlow:start");
  const finalized = await finalizeDoctorConfigFlow({
    cfg,
    candidate,
    pendingChanges,
    shouldRepair,
    fixHints,
    confirm: params.confirm,
    note,
  });
  debugDoctor("doctor-config-flow:finalizeDoctorConfigFlow:done");
  cfg = finalized.cfg;

  noteOpencodeProviderOverrides(cfg);

  return {
    cfg,
    path: snapshot.path ?? CONFIG_PATH,
    shouldWriteConfig: finalized.shouldWriteConfig,
    sourceConfigValid: snapshot.valid,
  };
}
