import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
  withDeferredPluginMigrationsCurrent,
} from "./deferred-plugin-migrations.js";
import { tryAcquireExclusiveSqliteCoordinator } from "./sqlite-coordinator.js";
import {
  readMigrationCheckpointStatus,
  recordSuccessfulStartupMigrations,
} from "./startup-migration-checkpoint.js";
import {
  resolveStateDatabaseCoordinatorPath,
  resolveStateLifecycleRuntimeDirectory,
} from "./state-database-coordinator.js";

const log = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (...args: Parameters<typeof actual.createSubsystemLogger>) => ({
      ...actual.createSubsystemLogger(...args),
      ...log,
    }),
  };
});

describe("deferred configured-plugin migrations", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function fixture() {
    const root = tempDirs.make("openclaw-deferred-plugin-migrations-");
    const stateDir = path.join(root, "state");
    return { stateDir, env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
  }

  it("reads absent migration state without creating a database", () => {
    const { env, stateDir } = fixture();
    expect(readDeferredPluginMigrations({ env })).toEqual([]);
    expect(fs.existsSync(stateDir)).toBe(false);
  });

  it.each(["absent", "historical"] as const)(
    "publishes without changing %s state when no plugin migration is pending",
    (state) => {
      const { env, stateDir } = fixture();
      const databasePath = resolveOpenClawStateSqlitePath(env);
      if (state === "historical") {
        openOpenClawStateDatabase({ env });
        closeOpenClawStateDatabaseForTest();
        using database = new DatabaseSync(databasePath);
        // Match the rollback rehearsal: publication does not own schema repair.
        database.exec("PRAGMA user_version = 7");
      }
      const before = state === "historical" ? fs.readFileSync(databasePath) : undefined;
      const coordinatorPath = resolveStateDatabaseCoordinatorPath({
        databasePath,
        runtimeDirectory: resolveStateLifecycleRuntimeDirectory(),
        uid: typeof process.getuid === "function" ? process.getuid() : undefined,
      });
      const outputPath = path.join(path.dirname(stateDir), "published.txt");
      withDeferredPluginMigrationsCurrent({ env, expectedPending: [] }, () => {
        const contender = tryAcquireExclusiveSqliteCoordinator(coordinatorPath, {
          busyTimeoutMs: 0,
        });
        try {
          expect(contender).toBeNull();
          fs.writeFileSync(outputPath, "published");
        } finally {
          contender?.release();
        }
      });
      expect(fs.readFileSync(outputPath, "utf8")).toBe("published");
      if (before) {
        expect(fs.readFileSync(databasePath)).toEqual(before);
      } else {
        expect(fs.existsSync(stateDir)).toBe(false);
      }
    },
  );

  it.each(["discovery snapshot", "outer transaction"] as const)(
    "rechecks newly claimed inputs within %s scope before publication",
    async (scope) => {
      const { env, stateDir } = fixture();
      openOpenClawStateDatabase({ env });
      const outputPath = path.join(path.dirname(stateDir), "published.txt");
      const publish = () => {
        recordDeferredPluginMigrations({
          env,
          pending: [
            { pluginId: "sample", reason: "Missing package", command: "openclaw doctor --fix" },
          ],
        });
        expect(() =>
          withDeferredPluginMigrationsCurrent({ env, expectedPending: [] }, () => {
            fs.writeFileSync(outputPath, "published");
          }),
        ).toThrow("Plugin migration obligations changed");
        expect(fs.existsSync(outputPath)).toBe(false);
      };
      if (scope === "discovery snapshot") {
        await withOpenClawStateDatabaseReadSnapshot(async () => publish(), { env });
      } else {
        runOpenClawStateWriteTransaction(publish, { env });
      }
    },
  );

  it.each(["identical", "stronger", "additional"] as const)(
    "resolves only the captured pending generation after an %s report",
    (change) => {
      const { env } = fixture();
      const pending = {
        pluginId: "fixture-plugin",
        reason: "The configured plugin is not installed.",
        command: "openclaw doctor --fix",
      };
      recordDeferredPluginMigrations({ env, pending: [pending] });
      const expectedPending = readDeferredPluginMigrations({ env });
      recordDeferredPluginMigrations({
        env,
        pending: [
          change === "stronger"
            ? { ...pending, requiresStateMigration: true }
            : change === "additional"
              ? { ...pending, pluginId: "new-plugin" }
              : pending,
        ],
      });
      const before = readDeferredPluginMigrations({ env });
      const complete = () =>
        recordDeferredPluginMigrations({
          env,
          pending: [],
          resolvedPluginIds: [pending.pluginId],
          expectedPending,
        });
      if (change === "identical") {
        expect(complete).not.toThrow();
        expect(readDeferredPluginMigrations({ env })).toEqual([]);
      } else {
        expect(complete).toThrow("Plugin migration obligations changed");
        expect(readDeferredPluginMigrations({ env })).toEqual(before);
      }
    },
  );

  it("invalidates successful checkpoints until deferred work completes and is certified again", () => {
    const { env } = fixture();
    const checkpoint = {
      env,
      buildIdentity: "test-build",
      version: "2026.9.3",
      identity: {
        effectiveConfigFingerprint: "config",
        pluginDoctorConfigFingerprint: "doctor-config",
        pluginMigrationFingerprint: "plugins",
      },
    };
    recordSuccessfulStartupMigrations(checkpoint);
    expect(readMigrationCheckpointStatus(checkpoint)).toBe("startup-current");
    recordDeferredPluginMigrations({
      env,
      pending: [
        {
          pluginId: "fixture-plugin",
          reason: "The configured plugin is not installed.",
          command: "openclaw doctor --fix",
        },
      ],
    });
    expect(readMigrationCheckpointStatus(checkpoint)).toBe("stale");
    recordDeferredPluginMigrations({ env, pending: [], resolvedPluginIds: ["fixture-plugin"] });
    expect(readMigrationCheckpointStatus(checkpoint)).toBe("stale");
    recordSuccessfulStartupMigrations(checkpoint);
    expect(readMigrationCheckpointStatus(checkpoint)).toBe("startup-current");
  });

  it("retains pending migrations across restart and resolves only the completed plugin", () => {
    const { env, stateDir } = fixture();
    const alpha = {
      pluginId: "alpha",
      reason: "The configured plugin is not installed.",
      command: "openclaw plugins install @example/alpha",
      configPaths: [
        ["plugins", "entries", "alpha"],
        ["session", "store"],
      ],
      validationExcludedPaths: [["session", "store"]],
    };
    const beta = {
      pluginId: "beta",
      reason: "Plugin convergence is deferred until the update parent exits.",
      command: "openclaw doctor --fix",
    };

    recordDeferredPluginMigrations({ env, pending: [alpha, beta] });
    closeOpenClawStateDatabaseForTest();
    const sharedStateDir = path.join(stateDir, "state");
    const snapshot = () =>
      Object.fromEntries(
        fs.readdirSync(sharedStateDir).map((name) => [
          name,
          createHash("sha256")
            .update(fs.readFileSync(path.join(sharedStateDir, name)))
            .digest("hex"),
        ]),
      );
    const beforeRead = snapshot();
    expect(readDeferredPluginMigrations({ env })).toEqual([alpha, beta]);
    expect(snapshot()).toEqual(beforeRead);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Plugin "alpha" state migration is pending:'),
      { pluginId: "alpha", reason: alpha.reason, action: alpha.command, status: "pending" },
    );

    log.warn.mockClear();
    recordDeferredPluginMigrations({ env, pending: [alpha] });
    expect(log.warn).not.toHaveBeenCalled();

    recordDeferredPluginMigrations({ env, pending: [], resolvedPluginIds: ["alpha"] });
    closeOpenClawStateDatabaseForTest();
    expect(readDeferredPluginMigrations({ env })).toEqual([beta]);
    expect(log.info).toHaveBeenCalledWith(
      'Deferred state migration completed for plugin "alpha".',
      {
        pluginId: "alpha",
        status: "completed",
      },
    );

    recordDeferredPluginMigrations({ env, pending: [], resolvedPluginIds: ["beta"] });
    closeOpenClawStateDatabaseForTest();
    expect(readDeferredPluginMigrations({ env })).toEqual([]);
  });

  it("preserves declared ownership when plugin metadata disappears until explicit completion", () => {
    const { env } = fixture();
    const declared = {
      pluginId: "fixture-plugin",
      requiresStateMigration: true as const,
      requiresDoctorInspection: true as const,
      reason: "Package convergence is pending.",
      command: "openclaw update repair",
      configPaths: [["legacyIntegration", "stateDirectory"]],
      validationExcludedPaths: [["legacyIntegration"]],
    };
    recordDeferredPluginMigrations({ env, pending: [declared] });
    const unavailable = {
      pluginId: declared.pluginId,
      reason: "Plugin metadata is no longer available.",
      command: "openclaw plugins install @example/fixture-plugin",
    };
    recordDeferredPluginMigrations({ env, pending: [unavailable] });
    closeOpenClawStateDatabaseForTest();
    expect(readDeferredPluginMigrations({ env })).toEqual([{ ...declared, ...unavailable }]);

    const additionalPath = ["plugins", "entries", "fixture-plugin", "config"];
    recordDeferredPluginMigrations({
      env,
      pending: [
        {
          ...unavailable,
          configPaths: [...declared.configPaths, additionalPath],
          validationExcludedPaths: declared.validationExcludedPaths,
        },
      ],
    });
    expect(readDeferredPluginMigrations({ env })).toEqual([
      {
        ...declared,
        ...unavailable,
        configPaths: [...declared.configPaths, additionalPath],
      },
    ]);

    recordDeferredPluginMigrations({ env, pending: [], resolvedPluginIds: [declared.pluginId] });
    expect(readDeferredPluginMigrations({ env })).toEqual([]);
    recordDeferredPluginMigrations({ env, pending: [unavailable] });
    expect(readDeferredPluginMigrations({ env })).toEqual([unavailable]);
  });
});
