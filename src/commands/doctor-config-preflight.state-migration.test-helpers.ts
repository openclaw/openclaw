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

export function queueConfigSnapshot<T>(
  reader: { mockResolvedValueOnce(snapshot: T): unknown },
  snapshot: T,
  count = 1,
): void {
  for (let index = 0; index < count; index += 1) {
    reader.mockResolvedValueOnce(snapshot);
  }
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

export function makeQuarantinedPluginRepairConvergence(
  pluginId: string,
  repairPluginId: string | undefined,
): StartupConvergenceResult {
  return makeStartupConvergenceResult({
    errored: true,
    warnings: [
      {
        kind: "repair",
        pluginId: repairPluginId,
        reason: "npm package not found",
        message: `Failed to update ${repairPluginId ?? pluginId}: npm package not found.`,
        guidance: ["Run `openclaw update repair` to retry plugin repair."],
      },
      {
        pluginId,
        reason: "missing-package-json: package.json is missing",
        message: `Plugin "${pluginId}" failed post-core payload smoke check (missing): package.json is missing`,
        guidance: [
          "Run `openclaw update repair` to retry plugin repair.",
          `Run \`openclaw plugins inspect ${pluginId} --runtime --json\` for details.`,
        ],
      },
    ],
    smokeFailures: [
      {
        pluginId,
        installPath: `/plugins/${pluginId}`,
        reason: "missing-package-json",
        detail: "package.json is missing",
      },
    ],
  });
}
