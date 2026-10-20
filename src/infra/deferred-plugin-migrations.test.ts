import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as lease from "../plugins/plugin-lifecycle-lease.js";
import { stateNativeProcessEntrypoints } from "../state/native-process-runtime.test-support.js";
import * as stateDatabaseHandles from "../state/openclaw-state-db-handle.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../state/openclaw-state-db-readonly.js";
import * as state from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { openExistingSqliteWorkerBackend } from "../state/openclaw-state.worker.js";
import * as migrations from "./deferred-plugin-migrations.js";
import type { DeferredPluginMigration } from "./deferred-plugin-migrations.js";
import * as stateOwners from "./gateway-state-owner.js";
import * as kyselyCache from "./kysely-sync-cache-state.js";
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
  const receiptDefaults = { startedAt: 1, finishedAt: null, upsert: true };
  const migration = <T extends Partial<DeferredPluginMigration>>(overrides: T) => ({
    ...pending,
    ...overrides,
  });
  const read = () => migrations.readDeferredPluginMigrations({ env });
  const readAsync = (artifactPreservingReadOnly?: boolean) =>
    migrations.readDeferredPluginMigrationsAsync({ env, artifactPreservingReadOnly });
  const completions = () => migrations.readDeferredPluginMigrationCompletions({ env });
  const transaction = <T>(run: Parameters<typeof state.runOpenClawStateWriteTransaction<T>>[0]) =>
    state.runOpenClawStateWriteTransaction(run, { env });
  type RecordOptions = Omit<migrations.DeferredPluginMigrationRecordInput, "env" | "pending">;
  const record = (entries: DeferredPluginMigration[] = [pending], options: RecordOptions = {}) =>
    migrations.recordDeferredPluginMigrations({ env, pending: entries, ...options });
  const resolve = (pluginId = pending.pluginId) => record([], { resolvedPluginIds: [pluginId] });
  const publish = <T>(run: () => T, expectedPending: DeferredPluginMigration[] = []) =>
    migrations.withDeferredPluginMigrationsCurrent({ env, expectedPending }, run);
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      state.closeOpenClawStateDatabaseForTest();
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
    state.openOpenClawStateDatabase({ env });
    state.closeOpenClawStateDatabaseForTest();
    using database = new DatabaseSync(resolveOpenClawStateSqlitePath(env));
    database.exec("PRAGMA user_version = 7");
  }

  const writeReceipt = (
    runId: string,
    status: string,
    reportJson: string,
    finishedAt: number | null = null,
  ) =>
    transaction(({ db }) =>
      recordLegacyMigrationRun(db, { ...receiptDefaults, runId, status, reportJson, finishedAt }),
    );
  const writePending = (entry: DeferredPluginMigration) =>
    writeReceipt(`deferred-plugin-migration:${entry.pluginId}`, "pending", JSON.stringify(entry));

  it.each([undefined, false])(
    "pins snapshots (preserve artifacts: %s)",
    async (preserveArtifacts) => {
      writePending(pending);
      await state.closeOpenClawStateDatabaseAsync();
      using writer = new DatabaseSync(resolveOpenClawStateSqlitePath(env));
      const changed = { ...pending, reason: "Committed after the inspection snapshot" };
      await withOpenClawStateDatabaseReadSnapshot(
        async () => {
          writer
            .prepare("UPDATE migration_runs SET report_json = ? WHERE id = ?")
            .run(JSON.stringify(changed), `deferred-plugin-migration:${pending.pluginId}`);
          expect(await readAsync(preserveArtifacts)).toEqual([pending]);
        },
        { env },
      );
      expect(await readAsync(preserveArtifacts)).toEqual([changed]);
    },
  );

  it("excludes a detached migration writer while the plugin lease pins policy rows", async () => {
    const leasedMigration = migration({ pluginId: "fixture", reason: "Waiting for repair" });
    let writerSettled = false;
    let writer: Promise<unknown> | undefined;

    await lease.withPluginLifecycleLease({ env }, async () => {
      writer = lease.runOutsidePluginLifecycleLease(() =>
        record([leasedMigration]).finally(() => {
          writerSettled = true;
        }),
      );
      await vi.waitFor(() => expect(lease.hasPluginLifecycleLeaseDemand()).toBe(true));
      expect(writerSettled).toBe(false);
      expect(read()).toEqual([]);
    });

    await writer;
    expect(writerSettled).toBe(true);
    expect(read()).toEqual([leasedMigration]);
  });

  it.each(["transaction", "commit"] as const)("rolls back revoked %s admission", async (stage) => {
    const revoked = new Error("Plugin repair requester revoked");
    let observed = false;
    await expect(
      lease.withPluginLifecycleLease(
        {
          env,
          assertCurrent: () => {
            if (observed) {
              throw revoked;
            }
          },
        },
        async () => {
          using _ = probe.admission(workerAdmission, (request, grant, admit) => {
            if (
              request.stage === stage &&
              isRecord(request.facts) &&
              request.facts.kind === "state-lease"
            ) {
              observed = true;
            }
            return admit(request, grant);
          });
          await record();
        },
      ),
    ).rejects.toThrow("Plugin repair requester revoked");
    expect(observed).toBe(true);
    expect(read()).toEqual([]);
    await record();
    expect(read()).toEqual([pending]);
  });

  it.each(["absent", "historical"] as const)("preserves empty %s state", (kind) => {
    if (kind === "absent") {
      expect(read()).toEqual([]);
      expect(completions()).toEqual([]);
      expect(fs.existsSync(stateDir)).toBe(false);
    }
    const databasePath = resolveOpenClawStateSqlitePath(env);
    if (kind === "historical") {
      // Match the rollback rehearsal: publication does not own schema repair.
      prepareHistoricalState();
    }
    const before = kind === "historical" ? fs.readFileSync(databasePath) : undefined;
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
      if (kind === "historical") {
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
  });

  it("rechecks obligations created before missing-state publication acquires ownership", () => {
    const acquire = stateOwners.acquireStateDatabaseSchemaLease;
    using _ = vi
      .spyOn(stateOwners, "acquireStateDatabaseSchemaLease")
      .mockImplementationOnce((databasePath) => {
        writePending(pending);
        state.closeOpenClawStateDatabaseForTest();
        return acquire(databasePath);
      });
    const output = vi.fn();
    expect(() => publish(output)).toThrow("Plugin migration obligations changed");
    expect(output).not.toHaveBeenCalled();
    expect(read()).toEqual([pending]);
  });

  it("closes historical publication state when statement-cache cleanup fails", () => {
    prepareHistoricalState();
    const open = stateDatabaseHandles.openTrackedStateDatabase;
    let opened: DatabaseSync | undefined;
    using _ = vi
      .spyOn(stateDatabaseHandles, "openTrackedStateDatabase")
      .mockImplementation((...args) => (opened = open(...args)));
    using clear = vi.spyOn(kyselyCache, "clearNodeSqliteKyselyCacheForDatabase");
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
      if (opened?.isOpen) {
        opened.close();
      }
    }
  });

  it.each(["absent", "historical"])("rejects asynchronous publication in %s state", (kind) => {
    if (kind === "historical") {
      prepareHistoricalState();
    }
    const output = vi.fn(async () => "published");
    expect(() => publish(output)).toThrow(/synchronous|Promise/u);
    expect(output).toHaveBeenCalledOnce();
  });

  it.each(["discovery snapshot", "outer transaction"] as const)(
    "rechecks claims in %s",
    async (scope) => {
      state.openOpenClawStateDatabase({ env });
      const outputPath = path.join(path.dirname(stateDir), "published.txt");
      const attempt = () => {
        writePending(pending);
        expect(() => publish(() => fs.writeFileSync(outputPath, "published"))).toThrow(
          "Plugin migration obligations changed",
        );
        expect(fs.existsSync(outputPath)).toBe(false);
      };
      if (scope === "discovery snapshot") {
        await withOpenClawStateDatabaseReadSnapshot(async () => attempt(), { env });
      } else {
        transaction(attempt);
      }
    },
  );

  it("accepts the current publication generation and rejects its predecessor", async () => {
    const current = { ...pending, requiresStateMigration: true as const };
    await record();
    publish(() => {
      writePending(current);
      // Discovery still observes committed rows; publication must see its own writes.
      expect(read()).toEqual([pending]);
      const check = (entry: DeferredPluginMigration) => () =>
        migrations.assertDeferredPluginMigrationsCurrent({ env, expectedPending: [entry] });
      expect(check(current)).not.toThrow();
      expect(check(pending)).toThrow("Plugin migration obligations changed");
    }, [pending]);
    expect(read()).toEqual([current]);
  });

  it.each(["identical", "stronger", "additional"] as const)(
    "checks generation after %s report",
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
    const { db } = state.openOpenClawStateDatabase({ env });
    const fixtureKeys = ["state-migrations", "startup-migrations", "unrelated-metadata"];
    const readFixtureMetadata = () =>
      db.prepare("SELECT * FROM schema_meta WHERE meta_key IN (?, ?, ?)").all(...fixtureKeys);
    transaction(({ db: writeDb }) => {
      const insert = writeDb.prepare(
        "INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at) VALUES (?, 'global', 3, NULL, ?, 1, 1)",
      );
      for (const key of fixtureKeys) {
        insert.run(key, "2026.9.3\n3\ntest-build\nconfig\ndoctor-config\nplugins");
      }
    });
    const seeded = readFixtureMetadata();
    expect(seeded.map((row) => row.meta_key).toSorted()).toEqual(fixtureKeys.toSorted());
    const unrelated = seeded.filter((row) => row.meta_key === "unrelated-metadata");
    await record();
    expect(readFixtureMetadata()).toEqual(unrelated);
    await resolve();
    expect(readFixtureMetadata()).toEqual(unrelated);
  });

  it("serves the published 2026.10.1 updater's shared-state pending read after replacement", async () => {
    await record();
    await state.closeOpenClawStateDatabaseAsync();
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
    const alpha = migration({
      pluginId: "alpha",
      command: "openclaw plugins install @example/alpha",
      configPaths: [
        ["plugins", "entries", "alpha"],
        ["session", "store"],
      ],
      validationExcludedPaths: [["session", "store"]],
    });
    const beta = migration({
      pluginId: "beta",
      reason: "Plugin convergence is deferred until the update parent exits.",
    });

    await record([alpha, beta]);
    await state.closeOpenClawStateDatabaseAsync();
    const sharedStateDir = path.join(stateDir, "state");
    const snapshot = () =>
      Object.fromEntries(
        fs
          .readdirSync(sharedStateDir)
          .map((name) => [name, fs.readFileSync(path.join(sharedStateDir, name))]),
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

    await resolve("alpha");
    for (const [runId, status] of [
      ["deferred-plugin-migration:alpha", "completed"],
      ["deferred-plugin-migration:failed", "failed"],
      ["unrelated-migration", "pending"],
    ]) {
      writeReceipt(runId, status, "{", 2);
    }
    state.closeOpenClawStateDatabaseForTest();
    expect(read()).toEqual([beta]);
    expect(completions()).toEqual([{ pluginId: "alpha", completedAtMs: 2 }]);
    expect(log.info).toHaveBeenCalledWith(
      'Deferred state migration completed for plugin "alpha".',
      { pluginId: "alpha", status: "completed" },
    );

    await resolve("beta");
    state.closeOpenClawStateDatabaseForTest();
    expect(read()).toEqual([]);
  });

  it("preserves declared ownership when plugin metadata disappears until explicit completion", async () => {
    const declared = migration({
      requiresStateMigration: true as const,
      requiresDoctorInspection: true as const,
      reason: "Package convergence is pending.",
      command: "openclaw update repair",
      configPaths: [["legacyIntegration", "stateDirectory"]],
      validationExcludedPaths: [["legacyIntegration"]],
    });
    await record([declared]);
    const unavailable = migration({
      reason: "Plugin metadata is no longer available.",
      command: "openclaw plugins install @example/fixture-plugin",
    });
    await record([unavailable]);
    state.closeOpenClawStateDatabaseForTest();
    expect(read()).toEqual([{ ...declared, ...unavailable }]);

    const additionalPath = ["plugins", "entries", "fixture-plugin", "config"];
    const paths = {
      configPaths: [...declared.configPaths, additionalPath],
      validationExcludedPaths: declared.validationExcludedPaths,
    };
    await record([{ ...unavailable, ...paths }]);
    expect(read()).toEqual([{ ...declared, ...unavailable, ...paths }]);

    await resolve(declared.pluginId);
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
      state.closeOpenClawStateDatabaseForTest();
      expect(read).toThrow(error);
      await expect(
        record([{ ...pending, pluginId: "new", reason: "Not installed" }]),
      ).rejects.toThrow(error);
      writeMalformed("completed");
      state.closeOpenClawStateDatabaseForTest();
      expect(read()).toEqual([]);
    },
  );
});

const command = "openclaw update repair";
const retry = 'Run "openclaw update repair", then "openclaw doctor --fix" to retry the upgrade.';
const waiting =
  'Let the current update or repair finish. If this warning remains afterward, run "openclaw update repair", then "openclaw doctor --fix" to retry the upgrade.';

it.each([
  [{ OPENCLAW_UPDATE_IN_PROGRESS: "1" }, command, waiting],
  [
    { OPENCLAW_UPDATE_IN_PROGRESS: "1", OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1" },
    command,
    retry,
  ],
  [{}, command, retry],
  [{}, "openclaw doctor --fix", 'Run "openclaw doctor --fix" to retry the upgrade.'],
] as const)("formats repair guidance for %j / %s", (env, repairCommand, next) => {
  const pending = {
    pluginId: "fixture-plugin",
    reason: "Package repair deferred.",
    command: repairCommand,
  };
  expect(migrations.formatDeferredPluginMigration(pending, env)).toBe(
    `Plugin "fixture-plugin" data/settings upgrade is unfinished: Package repair deferred. Your existing data and settings have been kept. ${next}`,
  );
});
