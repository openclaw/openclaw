import { formatConfigIssueLines } from "../../../config/issue-format.js";
import { stripUnknownConfigKeys } from "../../doctor-config-analysis.js";
import type { DoctorConfigPreflightResult } from "../../doctor-config-preflight.js";
import type { DoctorConfigMutationState } from "./config-mutation-state.js";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";

export function applyLegacyCompatibilityStep(params: {
  snapshot: DoctorConfigPreflightResult["snapshot"];
  state: DoctorConfigMutationState;
  shouldRepair: boolean;
  doctorFixCommand: string;
}): {
  state: DoctorConfigMutationState;
  issueLines: string[];
  changeLines: string[];
} {
  if (params.snapshot.legacyIssues.length === 0) {
    return {
      state: params.state,
      issueLines: [],
      changeLines: [],
    };
  }

  const issueLines = formatConfigIssueLines(params.snapshot.legacyIssues, "-");
  const { config: migrated, changes } = migrateLegacyConfig(params.snapshot.parsed);
  if (!migrated) {
    return {
      state: {
        ...params.state,
        pendingChanges: params.state.pendingChanges || params.snapshot.legacyIssues.length > 0,
        fixHints: params.shouldRepair
          ? params.state.fixHints
          : [
              ...params.state.fixHints,
              `Run "${params.doctorFixCommand}" to migrate legacy config keys.`,
            ],
      },
      issueLines,
      changeLines: changes,
    };
  }

  return {
    state: {
      // Doctor should keep using the best-effort migrated shape in memory even
      // during preview mode; confirmation only controls whether we write it.
      cfg: migrated,
      candidate: migrated,
      // The read path can normalize legacy config into the snapshot before
      // migrateLegacyConfig emits concrete mutations. Legacy issues still mean
      // the on-disk config needs a doctor --fix path.
      pendingChanges: params.state.pendingChanges || params.snapshot.legacyIssues.length > 0,
      fixHints: params.shouldRepair
        ? params.state.fixHints
        : [
            ...params.state.fixHints,
            `Run "${params.doctorFixCommand}" to migrate legacy config keys.`,
          ],
    },
    issueLines,
    changeLines: changes,
  };
}

export function applyUnknownConfigKeyStep(params: {
  state: DoctorConfigMutationState;
  shouldRepair: boolean;
  shouldForce?: boolean;
  doctorFixCommand: string;
}): {
  state: DoctorConfigMutationState;
  removed: string[];
} {
  const unknown = stripUnknownConfigKeys(params.state.candidate);
  if (unknown.removed.length === 0) {
    return { state: params.state, removed: [] };
  }

  // Only strip unknown keys when --fix --force is used (opt-in destructive
  // cleanup). Plain --fix preserves unknown keys to avoid silently deleting
  // custom integrations or user-defined objects. (#69631)
  if (params.shouldRepair && params.shouldForce) {
    return {
      state: {
        cfg: unknown.config,
        candidate: unknown.config,
        pendingChanges: true,
        fixHints: params.state.fixHints,
      },
      removed: unknown.removed,
    };
  }

  return {
    state: {
      ...params.state,
      // Candidate retains stripped config for display only; cfg is untouched.
      candidate: params.shouldRepair ? params.state.candidate : unknown.config,
      pendingChanges: params.state.pendingChanges || !params.shouldRepair,
      fixHints: params.shouldRepair
        ? params.state.fixHints
        : [
            ...params.state.fixHints,
            `Run "${params.doctorFixCommand} --force" to remove these keys.`,
          ],
    },
    removed: unknown.removed,
  };
}
