export function makePreflightConfigSnapshot(config: Record<string, unknown>) {
  return {
    exists: true,
    valid: true,
    config,
    sourceConfig: config,
    parsed: config,
    legacyIssues: [],
    warnings: [],
    issues: [],
  };
}

export type StateMigrationResult = {
  migrated: boolean;
  skipped: boolean;
  changes: string[];
  warnings: string[];
  notices?: string[];
};

export function makeStateMigrationResult(changes: string[], migrated = true): StateMigrationResult {
  return { migrated, skipped: false, changes, warnings: [] };
}

type StartupConvergenceWarning = {
  kind?: "load" | "repair";
  pluginId?: string;
  reason: string;
  message: string;
  guidance: string[];
};

export type StartupSmokeFailure = {
  pluginId: string;
  installPath?: string;
  reason:
    | "missing-install-path"
    | "missing-main-entry"
    | "missing-package-json"
    | "unreadable-package-json";
  detail: string;
};

export type StartupConvergenceResult = {
  changes: string[];
  notices?: StartupConvergenceWarning[];
  warnings: StartupConvergenceWarning[];
  errored: boolean;
  smokeFailures: StartupSmokeFailure[];
  installRecords: Record<string, unknown>;
};

export function makeStartupConvergenceResult(
  overrides: Partial<StartupConvergenceResult> = {},
): StartupConvergenceResult {
  return {
    changes: [],
    notices: [],
    warnings: [],
    errored: false,
    smokeFailures: [],
    installRecords: {},
    ...overrides,
  };
}
