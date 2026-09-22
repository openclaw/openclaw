import { afterEach, expect, it, vi, type Mock } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";

export function makePreflightConfigSnapshot(
  config: Record<string, unknown>,
): Pick<
  ConfigFileSnapshot,
  "exists" | "valid" | "config" | "sourceConfig" | "parsed" | "legacyIssues" | "warnings" | "issues"
> {
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

export function expectMigrationIdentity(): {
  effectiveConfigFingerprint: unknown;
  pluginDoctorConfigFingerprint: unknown;
  pluginMigrationFingerprint: string;
} {
  return {
    effectiveConfigFingerprint: expect.any(String),
    pluginDoctorConfigFingerprint: expect.any(String),
    pluginMigrationFingerprint: "plugin-migrations",
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

const maybeRepairPluginOpenClawHostLinks = vi.hoisted(() =>
  vi.fn(
    async (_params: {
      env: NodeJS.ProcessEnv;
      prompter: { shouldRepair: boolean };
    }): Promise<boolean> => false,
  ),
);

vi.mock("./doctor-plugin-host-links.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./doctor-plugin-host-links.js")>();
  return { ...actual, maybeRepairPluginOpenClawHostLinks };
});

export function getMaybeRepairPluginOpenClawHostLinksMock() {
  return maybeRepairPluginOpenClawHostLinks;
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

export const stateCheckpointOptions = {
  migrateState: true,
  migrateLegacyConfig: false,
  invalidConfigNote: false,
  requireStateMigrationCheckpoint: true,
} as const;

export const startupCheckpointOptions = {
  migrateLegacyConfig: false,
  invalidConfigNote: false,
  requireStartupMigrationCheckpoint: true,
} as const;

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

export function registerStartupPluginConvergenceTests(params: {
  runDoctorConfigPreflight: typeof import("./doctor-config-preflight.js").runDoctorConfigPreflight;
  readMigrationCheckpointStatus: Mock<() => "stale" | "state-current" | "startup-current">;
  runPostCorePluginConvergence: Mock<() => Promise<StartupConvergenceResult>>;
  runActivePluginPayloadSmokeCheck: unknown;
  recordSuccessfulStartupMigrations: unknown;
  note: unknown;
  startupEnv: () => NodeJS.ProcessEnv | undefined;
}) {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const {
    runDoctorConfigPreflight,
    readMigrationCheckpointStatus,
    runPostCorePluginConvergence,
    runActivePluginPayloadSmokeCheck,
    recordSuccessfulStartupMigrations,
    note,
    startupEnv,
  } = params;
  it("pins startup plugin convergence without re-persisting the installed record snapshot", async () => {
    readMigrationCheckpointStatus.mockReturnValue("stale");
    const previousHostVersion = process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
    process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION = "2026.7.2-beta.7";

    try {
      await runDoctorConfigPreflight(startupCheckpointOptions);
    } finally {
      if (previousHostVersion === undefined) {
        delete process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
      } else {
        process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION = previousHostVersion;
      }
    }

    expect(runPostCorePluginConvergence).toHaveBeenCalledWith({
      cfg: { gateway: { mode: "local", port: 19091 } },
      env: startupEnv(),
      compatibilityHostVersion: "2026.7.2-beta.7",
    });
  });

  it("defers network plugin refresh in a shipped-driver canary while verifying copied payloads", async () => {
    readMigrationCheckpointStatus.mockReturnValue("stale");
    const env = {
      ...buildUpdateRehearsalPathEnv(tempDirs.make("openclaw-update-canary-fixture-")),
      OPENCLAW_UPDATE_IN_PROGRESS: "0",
      OPENCLAW_SERVICE_REPAIR_POLICY: "external",
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
      OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
    };
    for (const [key, value] of Object.entries(env)) {
      vi.stubEnv(key, value);
    }
    try {
      await runPostCorePluginConvergence.withImplementation(
        async () => {
          throw new Error("Registry refresh consumed the canary startup budget");
        },
        () => runDoctorConfigPreflight(startupCheckpointOptions),
      );
      expect(runPostCorePluginConvergence).not.toHaveBeenCalled();
      expect(runActivePluginPayloadSmokeCheck).toHaveBeenCalledOnce();
      expect(note).toHaveBeenCalledWith(
        expect.stringContaining("Plugin refresh deferred"),
        "Doctor warnings",
      );
      expect(recordSuccessfulStartupMigrations).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllEnvs();
    }
  });
}
