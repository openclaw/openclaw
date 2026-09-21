import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  assertDeferredPluginMigrationsCurrent,
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
  formatDeferredPluginMigration,
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
import { recordLegacyMigrationRun } from "./state-migrations.receipts.js";

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

  it.each(["prior", "current"] as const)(
    "checks the %s pending generation against its publication transaction",
    (generation) => {
      const { env } = fixture();
      const pending = {
        pluginId: "fixture-plugin",
        reason: "The configured plugin is not installed.",
        command: "openclaw doctor --fix",
      };
      const current = { ...pending, requiresStateMigration: true as const };
      recordDeferredPluginMigrations({ env, pending: [pending] });
      withDeferredPluginMigrationsCurrent({ env, expectedPending: [pending] }, () => {
        expect(recordDeferredPluginMigrations({ env, pending: [current] })).toEqual([current]);
        // Discovery still observes committed rows; publication must see its own writes.
        expect(readDeferredPluginMigrations({ env })).toEqual([pending]);
        const check = () =>
          assertDeferredPluginMigrationsCurrent({
            env,
            expectedPending: [generation === "prior" ? pending : current],
          });
        if (generation === "prior") {
          expect(check).toThrow("Plugin migration obligations changed");
        } else {
          expect(check).not.toThrow();
        }
      });
      expect(readDeferredPluginMigrations({ env })).toEqual([current]);
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
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        for (const [runId, status] of [
          ["deferred-plugin-migration:alpha", "completed"],
          ["deferred-plugin-migration:failed", "failed"],
          ["unrelated-migration", "pending"],
        ] as const) {
          recordLegacyMigrationRun(db, {
            runId,
            startedAt: 1,
            finishedAt: 2,
            status,
            reportJson: "{",
            upsert: true,
          });
        }
      },
      { env },
    );
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

  it.each([
    { reportJson: "{", error: SyntaxError },
    { reportJson: "{}", error: ZodError },
  ])(
    "rejects malformed pending reports and rolls back new deferrals: $reportJson",
    ({ reportJson, error }) => {
      const { env } = fixture();
      const writeReceipt = (status: string) =>
        runOpenClawStateWriteTransaction(
          ({ db }) =>
            recordLegacyMigrationRun(db, {
              runId: "deferred-plugin-migration:malformed",
              startedAt: 1,
              finishedAt: null,
              status,
              reportJson,
              upsert: true,
            }),
          { env },
        );
      writeReceipt("pending");
      closeOpenClawStateDatabaseForTest();
      expect(() => readDeferredPluginMigrations({ env })).toThrow(error);
      expect(() =>
        recordDeferredPluginMigrations({
          env,
          pending: [{ pluginId: "new", reason: "Not installed", command: "openclaw doctor --fix" }],
        }),
      ).toThrow(error);
      writeReceipt("completed");
      closeOpenClawStateDatabaseForTest();
      expect(readDeferredPluginMigrations({ env })).toEqual([]);
    },
  );
});

describe("deferred plugin migration repair guidance", () => {
  const pending = {
    pluginId: "fixture-plugin",
    reason: "Package repair deferred.",
    command: "openclaw update repair",
  };

  it.each(["OPENCLAW_UPDATE_IN_PROGRESS", "OPENCLAW_UPDATE_POST_CORE_CONVERGENCE"])(
    "waits for the owning update before suggesting another repair (%s)",
    (marker) => {
      const message = formatDeferredPluginMigration(pending, { [marker]: "1" });
      expect(message).toContain("Let the current update or repair finish.");
      expect(message).toContain('If this warning remains afterward, run "openclaw update repair"');
    },
  );

  it("gives immediate recovery outside an update and avoids repeating Doctor", () => {
    expect(formatDeferredPluginMigration(pending, {})).toContain(
      'Run "openclaw update repair", then "openclaw doctor --fix".',
    );
    const message = formatDeferredPluginMigration(
      { ...pending, command: "openclaw doctor --fix" },
      {},
    );
    expect(message.match(/openclaw doctor --fix/g)).toHaveLength(1);
    expect(message).not.toContain("Let the current");
  });
});
