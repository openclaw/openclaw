import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { stateNativeProcessEntrypoints } from "../state/native-process-runtime.test-support.js";
import * as stateDatabaseHandles from "../state/openclaw-state-db-handle.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../state/openclaw-state-db-readonly.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  type DeferredPluginMigration,
  assertDeferredPluginMigrationsCurrent,
  readDeferredPluginMigrationCompletions,
  readDeferredPluginMigrations,
  readDeferredPluginMigrationsAsync,
  recordDeferredPluginMigrations,
  formatDeferredPluginMigration,
  withDeferredPluginMigrationsCurrent,
} from "./deferred-plugin-migrations.js";
import * as stateOwners from "./gateway-state-owner.js";
import * as kyselyCache from "./kysely-sync-cache-state.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import * as workerAdmission from "./sqlite-worker-operation-admission.js";
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
  const pending = {
    pluginId: "fixture-plugin",
    reason: "The configured plugin is not installed.",
    command: "openclaw doctor --fix",
  };
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

  function prepareHistoricalState(env: NodeJS.ProcessEnv) {
    openOpenClawStateDatabase({ env });
    closeOpenClawStateDatabaseForTest();
    using database = new DatabaseSync(resolveOpenClawStateSqlitePath(env));
    database.exec("PRAGMA user_version = 7");
  }

  function writePending(env: NodeJS.ProcessEnv, migration: DeferredPluginMigration) {
    runOpenClawStateWriteTransaction(
      ({ db }) =>
        recordLegacyMigrationRun(db, {
          runId: `deferred-plugin-migration:${migration.pluginId}`,
          startedAt: 1,
          finishedAt: null,
          status: "pending",
          reportJson: JSON.stringify(migration),
          upsert: true,
        }),
      { env },
    );
  }

  it.each([undefined, false])(
    "keeps async inspection on its captured snapshot (preserve artifacts: %s)",
    async (artifactPreservingReadOnly) => {
      const { env } = fixture();
      writePending(env, pending);
      await closeOpenClawStateDatabaseAsync();
      using writer = new DatabaseSync(resolveOpenClawStateSqlitePath(env));
      const changed = { ...pending, reason: "Committed after the inspection snapshot" };
      await withOpenClawStateDatabaseReadSnapshot(
        async () => {
          writer
            .prepare("UPDATE migration_runs SET report_json = ? WHERE id = ?")
            .run(JSON.stringify(changed), `deferred-plugin-migration:${pending.pluginId}`);
          expect(
            await readDeferredPluginMigrationsAsync({ env, artifactPreservingReadOnly }),
          ).toEqual([pending]);
        },
        { env },
      );
      expect(await readDeferredPluginMigrationsAsync({ env, artifactPreservingReadOnly })).toEqual([
        changed,
      ]);
    },
  );

  it.each(["transaction", "commit"] as const)(
    "rolls back deferred obligations when the requester is revoked at worker %s admission",
    async (stage) => {
      const { env } = fixture();
      const revoked = new Error("Plugin repair requester revoked");
      let current = true;
      let observed = false;
      await expect(
        withPluginLifecycleLease(
          {
            env,
            assertCurrent: () => {
              if (!current) {
                throw revoked;
              }
            },
          },
          async () => {
            const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
            const spy = vi
              .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
              .mockImplementation((admit, attachment) =>
                createAdmission((request, grant) => {
                  if (
                    request.stage === stage &&
                    isRecord(request.facts) &&
                    request.facts.kind === "state-lease"
                  ) {
                    observed = true;
                    current = false;
                  }
                  return admit(request, grant);
                }, attachment),
              );
            try {
              await recordDeferredPluginMigrations({ env, pending: [pending] });
            } finally {
              spy.mockRestore();
            }
          },
        ),
      ).rejects.toThrow("Plugin repair requester revoked");
      expect(observed).toBe(true);
      expect(readDeferredPluginMigrations({ env })).toEqual([]);
      await recordDeferredPluginMigrations({ env, pending: [pending] });
      expect(readDeferredPluginMigrations({ env })).toEqual([pending]);
    },
  );

  it.each(["absent", "historical"] as const)(
    "publishes without changing %s state when no plugin migration is pending",
    (state) => {
      const { env, stateDir } = fixture();
      if (state === "absent") {
        expect(readDeferredPluginMigrations({ env })).toEqual([]);
        expect(readDeferredPluginMigrationCompletions({ env })).toEqual([]);
        expect(fs.existsSync(stateDir)).toBe(false);
      }
      const databasePath = resolveOpenClawStateSqlitePath(env);
      if (state === "historical") {
        // Match the rollback rehearsal: publication does not own schema repair.
        prepareHistoricalState(env);
      }
      const before = state === "historical" ? fs.readFileSync(databasePath) : undefined;
      const outputPath = path.join(path.dirname(stateDir), "published.txt");
      const probeForeignOwner = () => {
        const ownerUrl = resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.gatewayStateOwner);
        const result = spawnSync(
          process.execPath,
          [
            ...resolveRuntimeWorkerArgv(ownerUrl).slice(0, -1),
            "--input-type=module",
            "--eval",
            `
              import { tryAcquireGatewayStateOwner } from ${JSON.stringify(ownerUrl.href)};
              const owner = tryAcquireGatewayStateOwner(process.argv[1]);
              owner?.release();
              process.stdout.write(owner ? 'acquired' : 'refused');
            `,
            databasePath,
          ],
          { encoding: "utf8", timeout: 5_000 },
        );
        expect(result.status, result.stderr).toBe(0);
        return result.stdout;
      };
      withDeferredPluginMigrationsCurrent({ env, expectedPending: [] }, () => {
        if (state === "historical") {
          using contender = new DatabaseSync(databasePath);
          contender.exec("PRAGMA busy_timeout = 0");
          expect(() => contender.exec("BEGIN IMMEDIATE")).toThrow(/locked/i);
        } else {
          expect(probeForeignOwner()).toBe("refused");
        }
        fs.writeFileSync(outputPath, "published");
      });
      expect(fs.readFileSync(outputPath, "utf8")).toBe("published");
      if (before) {
        expect(fs.readFileSync(databasePath)).toEqual(before);
      } else {
        expect(fs.existsSync(stateDir)).toBe(false);
        expect(probeForeignOwner()).toBe("acquired");
      }
    },
  );

  it("rechecks obligations created before missing-state publication acquires ownership", () => {
    const { env } = fixture();
    const acquire = stateOwners.acquireStateDatabaseSchemaLease;
    const acquisition = vi
      .spyOn(stateOwners, "acquireStateDatabaseSchemaLease")
      .mockImplementationOnce((databasePath) => {
        writePending(env, pending);
        closeOpenClawStateDatabaseForTest();
        return acquire(databasePath);
      });
    const publish = vi.fn();
    try {
      expect(() =>
        withDeferredPluginMigrationsCurrent({ env, expectedPending: [] }, publish),
      ).toThrow("Plugin migration obligations changed");
      expect(publish).not.toHaveBeenCalled();
      expect(readDeferredPluginMigrations({ env })).toEqual([pending]);
    } finally {
      acquisition.mockRestore();
    }
  });

  it("closes historical publication state when statement-cache cleanup fails", () => {
    const { env } = fixture();
    prepareHistoricalState(env);
    const open = stateDatabaseHandles.openTrackedStateDatabase;
    let opened: DatabaseSync | undefined;
    const openedSpy = vi
      .spyOn(stateDatabaseHandles, "openTrackedStateDatabase")
      .mockImplementation((...args) => (opened = open(...args)));
    const clear = vi.spyOn(kyselyCache, "clearNodeSqliteKyselyCacheForDatabase");
    const publish = vi.fn(() => {
      clear.mockImplementationOnce(() => {
        throw new Error("Synthetic statement-cache cleanup failure");
      });
      return "published";
    });
    try {
      expect(() =>
        withDeferredPluginMigrationsCurrent({ env, expectedPending: [] }, publish),
      ).toThrow();
      expect(publish).toHaveBeenCalledOnce();
      expect(opened?.isOpen).toBe(false);
    } finally {
      clear.mockRestore();
      openedSpy.mockRestore();
      if (opened?.isOpen) {
        opened.close();
      }
    }
  });

  it.each(["absent", "historical"])(
    "rejects asynchronous publication inside %s state admission",
    (state) => {
      const { env } = fixture();
      if (state === "historical") {
        prepareHistoricalState(env);
      }
      const publish = vi.fn(async () => "published");
      expect(() =>
        withDeferredPluginMigrationsCurrent({ env, expectedPending: [] }, publish),
      ).toThrow(/synchronous|Promise/u);
      expect(publish).toHaveBeenCalledOnce();
    },
  );

  it.each(["discovery snapshot", "outer transaction"] as const)(
    "rechecks newly claimed inputs within %s scope before publication",
    async (scope) => {
      const { env, stateDir } = fixture();
      openOpenClawStateDatabase({ env });
      const outputPath = path.join(path.dirname(stateDir), "published.txt");
      const publish = () => {
        writePending(env, pending);
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
    async (generation) => {
      const { env } = fixture();
      const current = { ...pending, requiresStateMigration: true as const };
      await recordDeferredPluginMigrations({ env, pending: [pending] });
      withDeferredPluginMigrationsCurrent({ env, expectedPending: [pending] }, () => {
        writePending(env, current);
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
    async (change) => {
      const { env } = fixture();
      await recordDeferredPluginMigrations({ env, pending: [pending] });
      const expectedPending = readDeferredPluginMigrations({ env });
      await recordDeferredPluginMigrations({
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
        await expect(complete()).resolves.toEqual([]);
        expect(readDeferredPluginMigrations({ env })).toEqual([]);
      } else {
        await expect(complete()).rejects.toThrow("Plugin migration obligations changed");
        expect(readDeferredPluginMigrations({ env })).toEqual(before);
      }
    },
  );

  it("removes historical completion facts when work is deferred without changing other metadata", async () => {
    const { env } = fixture();
    const { db } = openOpenClawStateDatabase({ env });
    const metadata = getNodeSqliteKysely<Pick<DB, "schema_meta">>(db);
    const checkpointKeys = ["state-migrations", "startup-migrations"];
    const fixtureKeys = [...checkpointKeys, "unrelated-metadata"];
    const readFixtureMetadata = () =>
      executeSqliteQuerySync(
        db,
        metadata.selectFrom("schema_meta").selectAll().where("meta_key", "in", fixtureKeys),
      ).rows;
    runOpenClawStateWriteTransaction(
      ({ db: writeDb }) => {
        executeSqliteQuerySync(
          writeDb,
          metadata.insertInto("schema_meta").values(
            fixtureKeys.map((metaKey) => ({
              meta_key: metaKey,
              role: "global",
              schema_version: 3,
              agent_id: null,
              app_version: "2026.9.3\n3\ntest-build\nconfig\ndoctor-config\nplugins",
              created_at: 1,
              updated_at: 1,
            })),
          ),
        );
      },
      { env },
    );
    const seeded = readFixtureMetadata();
    expect(seeded.map((row) => row.meta_key).toSorted()).toEqual(fixtureKeys.toSorted());
    const unrelated = seeded.filter((row) => row.meta_key === "unrelated-metadata");
    await recordDeferredPluginMigrations({
      env,
      pending: [pending],
    });
    expect(readFixtureMetadata()).toEqual(unrelated);
    await recordDeferredPluginMigrations({
      env,
      pending: [],
      resolvedPluginIds: ["fixture-plugin"],
    });
    expect(readFixtureMetadata()).toEqual(unrelated);
  });

  it("retains pending migrations across restart and resolves only the completed plugin", async () => {
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

    await recordDeferredPluginMigrations({ env, pending: [alpha, beta] });
    await closeOpenClawStateDatabaseAsync();
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
      expect.stringContaining('Plugin "alpha" data/settings upgrade is unfinished:'),
      { pluginId: "alpha", reason: alpha.reason, action: alpha.command, status: "pending" },
    );

    log.warn.mockClear();
    await recordDeferredPluginMigrations({ env, pending: [alpha] });
    expect(log.warn).not.toHaveBeenCalled();

    await recordDeferredPluginMigrations({ env, pending: [], resolvedPluginIds: ["alpha"] });
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
    expect(readDeferredPluginMigrationCompletions({ env })).toEqual([
      { pluginId: "alpha", completedAtMs: 2 },
    ]);
    expect(log.info).toHaveBeenCalledWith(
      'Deferred state migration completed for plugin "alpha".',
      {
        pluginId: "alpha",
        status: "completed",
      },
    );

    await recordDeferredPluginMigrations({ env, pending: [], resolvedPluginIds: ["beta"] });
    closeOpenClawStateDatabaseForTest();
    expect(readDeferredPluginMigrations({ env })).toEqual([]);
  });

  it("preserves declared ownership when plugin metadata disappears until explicit completion", async () => {
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
    await recordDeferredPluginMigrations({ env, pending: [declared] });
    const unavailable = {
      pluginId: declared.pluginId,
      reason: "Plugin metadata is no longer available.",
      command: "openclaw plugins install @example/fixture-plugin",
    };
    await recordDeferredPluginMigrations({ env, pending: [unavailable] });
    closeOpenClawStateDatabaseForTest();
    expect(readDeferredPluginMigrations({ env })).toEqual([{ ...declared, ...unavailable }]);

    const additionalPath = ["plugins", "entries", "fixture-plugin", "config"];
    await recordDeferredPluginMigrations({
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

    await recordDeferredPluginMigrations({
      env,
      pending: [],
      resolvedPluginIds: [declared.pluginId],
    });
    expect(readDeferredPluginMigrations({ env })).toEqual([]);
    await recordDeferredPluginMigrations({ env, pending: [unavailable] });
    expect(readDeferredPluginMigrations({ env })).toEqual([unavailable]);
  });

  it.each([
    { reportJson: "{", error: SyntaxError },
    { reportJson: "{}", error: ZodError },
  ])(
    "rejects malformed pending reports and rolls back new deferrals: $reportJson",
    async ({ reportJson, error }) => {
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
      await expect(
        recordDeferredPluginMigrations({
          env,
          pending: [{ pluginId: "new", reason: "Not installed", command: "openclaw doctor --fix" }],
        }),
      ).rejects.toThrow(error);
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

  it.each([
    { marker: "OPENCLAW_UPDATE_IN_PROGRESS", command: pending.command },
    { marker: "OPENCLAW_UPDATE_POST_CORE_CONVERGENCE", command: pending.command },
    { marker: undefined, command: pending.command },
    { marker: undefined, command: "openclaw doctor --fix" },
  ])("formats repair guidance for $marker / $command", ({ marker, command }) => {
    const message = formatDeferredPluginMigration(
      { ...pending, command },
      marker ? { [marker]: "1" } : {},
    );
    expect(message).toContain('Plugin "fixture-plugin" data/settings upgrade is unfinished:');
    expect(message).toContain(pending.reason);
    expect(message).toContain("Your existing data and settings have been kept.");
    if (marker) {
      expect(message).toContain("Let the current update or repair finish.");
      expect(message).toContain('If this warning remains afterward, run "openclaw update repair"');
    } else {
      expect(message).not.toContain("Let the current");
      if (command === pending.command) {
        expect(message).toContain(
          'Run "openclaw update repair", then "openclaw doctor --fix" to retry the upgrade.',
        );
      } else {
        expect(message.match(/openclaw doctor --fix/g)).toHaveLength(1);
      }
    }
  });
});
