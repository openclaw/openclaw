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
      cfg: params.shouldRepair ? migrated : params.state.cfg,
      candidate: migrated,
      pendingChanges: params.state.pendingChanges || changes.length > 0,
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
  doctorFixCommand: string;
}): {
  state: DoctorConfigMutationState;
  removed: string[];
} {
  const unknown = stripUnknownConfigKeys(params.state.candidate);
  if (unknown.removed.length === 0) {
    return { state: params.state, removed: [] };
  }

  return {
    state: {
      cfg: params.shouldRepair ? unknown.config : params.state.cfg,
      candidate: unknown.config,
      pendingChanges: true,
      fixHints: params.shouldRepair
        ? params.state.fixHints
        : [...params.state.fixHints, `Run "${params.doctorFixCommand}" to remove these keys.`],
    },
    removed: unknown.removed,
  };
}
