import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  hasPluginLifecycleLeaseDemand,
  runOutsidePluginLifecycleLease,
  withPluginLifecycleLease,
} from "../plugins/plugin-lifecycle-lease.js";
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
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { openExistingSqliteWorkerBackend } from "../state/openclaw-state.worker.js";
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
import { SQLITE_WORKER_PREPARE_COMMAND } from "./sqlite-worker-contract.js";
import * as workerAdmission from "./sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "./sqlite-worker-owner-probe.test-support.js";
import { runWithSqliteWorkerStateContext } from "./sqlite-worker-state-context.js";
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
  let env: NodeJS.ProcessEnv;
  let stateDir: string;
  const read = () => readDeferredPluginMigrations({ env });
  const completions = () => readDeferredPluginMigrationCompletions({ env });
  const record = (
    migrations: DeferredPluginMigration[] = [pending],
    options: Omit<Parameters<typeof recordDeferredPluginMigrations>[0], "env" | "pending"> = {},
  ) => recordDeferredPluginMigrations({ env, pending: migrations, ...options });
  const publish = <T>(run: () => T, expectedPending: DeferredPluginMigration[] = []) =>
    withDeferredPluginMigrationsCurrent({ env, expectedPending }, run);
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    const root = tempDirs.make("openclaw-deferred-plugin-migrations-");
    stateDir = path.join(root, "state");
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  function prepareHistoricalState() {
    openOpenClawStateDatabase({ env });
    closeOpenClawStateDatabaseForTest();
    using database = new DatabaseSync(resolveOpenClawStateSqlitePath(env));
    database.exec("PRAGMA user_version = 7");
  }

  function writeReceipt(runId: string, status: string, reportJson: string) {
    runOpenClawStateWriteTransaction(
      ({ db }) =>
        recordLegacyMigrationRun(db, {
          runId,
          startedAt: 1,
          finishedAt: null,
          status,
          reportJson,
          upsert: true,
        }),
      { env },
    );
  }
  const writePending = (migration: DeferredPluginMigration) =>
    writeReceipt(
      `deferred-plugin-migration:${migration.pluginId}`,
      "pending",
      JSON.stringify(migration),
    );

  it.each([undefined, false])(
    "keeps async inspection on its captured snapshot (preserve artifacts: %s)",
    async (artifactPreservingReadOnly) => {
      writePending(pending);
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

  it("excludes a detached migration writer while the plugin lease pins policy rows", async () => {
    const leasedMigration = {
      pluginId: "fixture",
      reason: "Waiting for repair",
      command: "openclaw doctor --fix",
    };
    let writerSettled = false;
    let writer: Promise<unknown> | undefined;

    await withPluginLifecycleLease({ env }, async () => {
      writer = runOutsidePluginLifecycleLease(() =>
        record([leasedMigration]).finally(() => {
          writerSettled = true;
        }),
      );
      await vi.waitFor(() => expect(hasPluginLifecycleLeaseDemand()).toBe(true));
      expect(writerSettled).toBe(false);
      expect(read()).toEqual([]);
    });

    await writer;
    expect(writerSettled).toBe(true);
    expect(read()).toEqual([leasedMigration]);
  });

  it.each(["transaction", "commit"] as const)(
    "rolls back deferred obligations when the requester is revoked at worker %s admission",
    async (stage) => {
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
            const spy = probe.admission(workerAdmission, (request, grant, admit) => {
              if (
                request.stage === stage &&
                isRecord(request.facts) &&
                request.facts.kind === "state-lease"
              ) {
                observed = true;
                current = false;
              }
              return admit(request, grant);
            });
            try {
              await record();
            } finally {
              spy.mockRestore();
            }
          },
        ),
      ).rejects.toThrow("Plugin repair requester revoked");
      expect(observed).toBe(true);
      expect(read()).toEqual([]);
      await record();
      expect(read()).toEqual([pending]);
    },
  );

  it.each(["absent", "historical"] as const)(
    "publishes without changing %s state when no plugin migration is pending",
    (state) => {
      if (state === "absent") {
        expect(read()).toEqual([]);
        expect(completions()).toEqual([]);
        expect(fs.existsSync(stateDir)).toBe(false);
      }
      const databasePath = resolveOpenClawStateSqlitePath(env);
      if (state === "historical") {
        // Match the rollback rehearsal: publication does not own schema repair.
        prepareHistoricalState();
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
      publish(() => {
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
    const acquire = stateOwners.acquireStateDatabaseSchemaLease;
    const acquisition = vi
      .spyOn(stateOwners, "acquireStateDatabaseSchemaLease")
      .mockImplementationOnce((databasePath) => {
        writePending(pending);
        closeOpenClawStateDatabaseForTest();
        return acquire(databasePath);
      });
    const output = vi.fn();
    try {
      expect(() => publish(output)).toThrow("Plugin migration obligations changed");
      expect(output).not.toHaveBeenCalled();
      expect(read()).toEqual([pending]);
    } finally {
      acquisition.mockRestore();
    }
  });

  it("closes historical publication state when statement-cache cleanup fails", () => {
    prepareHistoricalState();
    const open = stateDatabaseHandles.openTrackedStateDatabase;
    let opened: DatabaseSync | undefined;
    const openedSpy = vi
      .spyOn(stateDatabaseHandles, "openTrackedStateDatabase")
      .mockImplementation((...args) => (opened = open(...args)));
    const clear = vi.spyOn(kyselyCache, "clearNodeSqliteKyselyCacheForDatabase");
    const output = vi.fn(() => {
      clear.mockImplementationOnce(() => {
        throw new Error("Synthetic statement-cache cleanup failure");
      });
      return "published";
    });
    try {
      expect(() => publish(output)).toThrow();
      expect(output).toHaveBeenCalledOnce();
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
      if (state === "historical") {
        prepareHistoricalState();
      }
      const output = vi.fn(async () => "published");
      expect(() => publish(output)).toThrow(/synchronous|Promise/u);
      expect(output).toHaveBeenCalledOnce();
    },
  );

  it.each(["discovery snapshot", "outer transaction"] as const)(
    "rechecks newly claimed inputs within %s scope before publication",
    async (scope) => {
      openOpenClawStateDatabase({ env });
      const outputPath = path.join(path.dirname(stateDir), "published.txt");
      const attempt = () => {
        writePending(pending);
        expect(() =>
          publish(() => {
            fs.writeFileSync(outputPath, "published");
          }),
        ).toThrow("Plugin migration obligations changed");
        expect(fs.existsSync(outputPath)).toBe(false);
      };
      if (scope === "discovery snapshot") {
        await withOpenClawStateDatabaseReadSnapshot(async () => attempt(), { env });
      } else {
        runOpenClawStateWriteTransaction(attempt, { env });
      }
    },
  );

  it.each(["prior", "current"] as const)(
    "checks the %s pending generation against its publication transaction",
    async (generation) => {
      const current = { ...pending, requiresStateMigration: true as const };
      await record();
      publish(() => {
        writePending(current);
        // Discovery still observes committed rows; publication must see its own writes.
        expect(read()).toEqual([pending]);
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
      }, [pending]);
      expect(read()).toEqual([current]);
    },
  );

  it.each(["identical", "stronger", "additional"] as const)(
    "resolves only the captured pending generation after an %s report",
    async (change) => {
      await record();
      const expectedPending = read();
      await record([
        change === "stronger"
          ? { ...pending, requiresStateMigration: true }
          : change === "additional"
            ? { ...pending, pluginId: "new-plugin" }
            : pending,
      ]);
      const before = read();
      const complete = () => record([], { resolvedPluginIds: [pending.pluginId], expectedPending });
      if (change === "identical") {
        await expect(complete()).resolves.toEqual([]);
        expect(read()).toEqual([]);
      } else {
        await expect(complete()).rejects.toThrow("Plugin migration obligations changed");
        expect(read()).toEqual(before);
      }
    },
  );

  it("removes historical completion facts when work is deferred without changing other metadata", async () => {
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
    await record();
    expect(readFixtureMetadata()).toEqual(unrelated);
    await record([], { resolvedPluginIds: [pending.pluginId] });
    expect(readFixtureMetadata()).toEqual(unrelated);
  });

  it("serves the published 2026.10.1 updater's shared-state pending read after replacement", async () => {
    await record();
    await closeOpenClawStateDatabaseAsync();
    const context = captureOpenClawStateWorkerContext({ env });
    const refuseWriter = vi
      .spyOn(stateDatabaseHandles, "openTrackedStateDatabase")
      .mockImplementation(() => {
        throw new Error("Writer admission refused");
      });
    const backend = runWithSqliteWorkerStateContext(context, () =>
      openExistingSqliteWorkerBackend(undefined, {
        databasePath: context.admission.databasePath,
        existingIdentity: context.admission.identity.key,
      }),
    );
    try {
      // 2026.10.1 sends this exact command to whichever shared-state worker its
      // stable worker entry loads, which is this package after replacement.
      await backend[SQLITE_WORKER_PREPARE_COMMAND]?.("plugins.deferredMigrations.read");
      const reply = runWithSqliteWorkerStateContext(context, () =>
        backend.execute({
          type: "plugins.deferredMigrations.read",
          input: { artifactPreservingReadOnly: true },
        }),
      );
      expect(reply).toEqual([pending]);
      expect(refuseWriter).not.toHaveBeenCalled();
    } finally {
      refuseWriter.mockRestore();
      await backend.close();
    }
  });

  it("retains pending migrations across restart and resolves only the completed plugin", async () => {
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

    await record([alpha, beta]);
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
    expect(read()).toEqual([alpha, beta]);
    expect(snapshot()).toEqual(beforeRead);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Plugin "alpha" data/settings upgrade is unfinished:'),
      { pluginId: "alpha", reason: alpha.reason, action: alpha.command, status: "pending" },
    );

    log.warn.mockClear();
    await record([alpha]);
    expect(log.warn).not.toHaveBeenCalled();

    await record([], { resolvedPluginIds: ["alpha"] });
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
    expect(read()).toEqual([beta]);
    expect(completions()).toEqual([{ pluginId: "alpha", completedAtMs: 2 }]);
    expect(log.info).toHaveBeenCalledWith(
      'Deferred state migration completed for plugin "alpha".',
      {
        pluginId: "alpha",
        status: "completed",
      },
    );

    await record([], { resolvedPluginIds: ["beta"] });
    closeOpenClawStateDatabaseForTest();
    expect(read()).toEqual([]);
  });

  it("preserves declared ownership when plugin metadata disappears until explicit completion", async () => {
    const declared = {
      pluginId: "fixture-plugin",
      requiresStateMigration: true as const,
      requiresDoctorInspection: true as const,
      reason: "Package convergence is pending.",
      command: "openclaw update repair",
      configPaths: [["legacyIntegration", "stateDirectory"]],
      validationExcludedPaths: [["legacyIntegration"]],
    };
    await record([declared]);
    const unavailable = {
      pluginId: declared.pluginId,
      reason: "Plugin metadata is no longer available.",
      command: "openclaw plugins install @example/fixture-plugin",
    };
    await record([unavailable]);
    closeOpenClawStateDatabaseForTest();
    expect(read()).toEqual([{ ...declared, ...unavailable }]);

    const additionalPath = ["plugins", "entries", "fixture-plugin", "config"];
    await record([
      {
        ...unavailable,
        configPaths: [...declared.configPaths, additionalPath],
        validationExcludedPaths: declared.validationExcludedPaths,
      },
    ]);
    expect(read()).toEqual([
      {
        ...declared,
        ...unavailable,
        configPaths: [...declared.configPaths, additionalPath],
      },
    ]);

    await record([], { resolvedPluginIds: [declared.pluginId] });
    expect(read()).toEqual([]);
    await record([unavailable]);
    expect(read()).toEqual([unavailable]);
  });

  it.each([
    { reportJson: "{", error: SyntaxError },
    { reportJson: "{}", error: ZodError },
  ])(
    "rejects malformed pending reports and rolls back new deferrals: $reportJson",
    async ({ reportJson, error }) => {
      const writeMalformed = (status: string) =>
        writeReceipt("deferred-plugin-migration:malformed", status, reportJson);
      writeMalformed("pending");
      closeOpenClawStateDatabaseForTest();
      expect(read).toThrow(error);
      await expect(
        record([{ ...pending, pluginId: "new", reason: "Not installed" }]),
      ).rejects.toThrow(error);
      writeMalformed("completed");
      closeOpenClawStateDatabaseForTest();
      expect(read()).toEqual([]);
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
    { markers: ["OPENCLAW_UPDATE_IN_PROGRESS"], command: pending.command, laterPass: true },
    // Post-core convergence is the final migration pass, even inside an update child.
    {
      markers: ["OPENCLAW_UPDATE_IN_PROGRESS", "OPENCLAW_UPDATE_POST_CORE_CONVERGENCE"],
      command: pending.command,
      laterPass: false,
    },
    { markers: [], command: pending.command, laterPass: false },
    { markers: [], command: "openclaw doctor --fix", laterPass: false },
  ])(
    "formats repair guidance for markers $markers / $command",
    ({ markers, command, laterPass }) => {
      const message = formatDeferredPluginMigration(
        { ...pending, command },
        Object.fromEntries(markers.map((marker) => [marker, "1"])),
      );
      expect(message).toContain('Plugin "fixture-plugin" data/settings upgrade is unfinished:');
      expect(message).toContain(pending.reason);
      expect(message).toContain("Your existing data and settings have been kept.");
      if (laterPass) {
        expect(message).toContain("Let the current update or repair finish.");
        expect(message).toContain(
          'If this warning remains afterward, run "openclaw update repair"',
        );
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
    },
  );
});
