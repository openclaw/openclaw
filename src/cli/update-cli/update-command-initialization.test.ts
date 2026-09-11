import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { SQLITE_SIDECAR_SUFFIXES } from "../../infra/sqlite-files.js";
import { createRetainedCheckpointFixture } from "../../infra/update-retained-checkpoint.test-support.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { preflightOpenClawDatabaseSchemas } from "../../state/openclaw-database-preflight.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { removePreparedWorkerOwnershipColumns } from "../../state/openclaw-state-schema-v17.test-support.js";

const mocks = vi.hoisted(() => ({ doctor: vi.fn() }));
vi.mock("./update-command-package.js", () => ({ runPackageUpdateDoctor: mocks.doctor }));

import {
  acquireLegacyUpdateInitializationFence,
  initializeUpdateStateFromTarget,
  updateStateNeedsInitialization,
} from "./update-command-initialization.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const targetSchemas = { state: 16, agent: 19 };
const doctorSuccess = {
  name: "openclaw doctor",
  command: "node openclaw.mjs doctor --non-interactive --fix",
  cwd: "/selected-target",
  durationMs: 1,
  exitCode: 0,
  stdoutTail: "",
  stderrTail: "",
};

beforeEach(() => {
  mocks.doctor.mockReset().mockResolvedValue(doctorSuccess);
});
afterEach(() => closeOpenClawStateDatabaseForTest());

function freshEnvironment() {
  const root = dirs.make("openclaw-update-initialization-");
  return { HOME: root, OPENCLAW_STATE_DIR: path.join(root, "profile") };
}

function createTargetDatabase() {
  const env = freshEnvironment();
  const filename = openOpenClawStateDatabase({ env }).path;
  closeOpenClawStateDatabaseForTest();
  const db = new DatabaseSync(filename);
  try {
    removePreparedWorkerOwnershipColumns(db);
    db.exec(
      "PRAGMA user_version=16; UPDATE schema_meta SET schema_version=16, app_version='2026.9.2'",
    );
  } finally {
    db.close();
  }
  return filename;
}

function publishTargetDatabase(source: string, env: NodeJS.ProcessEnv) {
  const filename = resolveOpenClawStateSqlitePath(env);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.copyFileSync(source, filename);
  return filename;
}

function inspectSchema(filename: string) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    return {
      version: db.prepare("PRAGMA user_version").get(),
      metadata: db.prepare("SELECT * FROM schema_meta").all(),
      schema: db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all(),
    };
  } finally {
    db.close();
  }
}

async function checkTargetSchemas(env: NodeJS.ProcessEnv) {
  const result = await preflightOpenClawDatabaseSchemas({ env, supportedVersions: targetSchemas });
  if (result.incompatible.length || result.indeterminate.length) {
    throw new Error("Selected target cannot open the current database schema");
  }
}

function initializationOptions(env: NodeJS.ProcessEnv) {
  return {
    root: "/selected-target",
    timeoutMs: 5_000,
    progress: {},
    env,
    assertCurrent() {},
    checkSchemas: () => checkTargetSchemas(env),
  };
}

describe("selected-target state initialization", () => {
  it("recognizes absent and existing state without creating or migrating either", async () => {
    const env = freshEnvironment();
    await expect(updateStateNeedsInitialization(env)).resolves.toBe(true);
    expect(fs.existsSync(env.OPENCLAW_STATE_DIR)).toBe(false);

    const filename = publishTargetDatabase(createTargetDatabase(), env);
    const before = fs.readFileSync(filename);
    await expect(updateStateNeedsInitialization(env)).resolves.toBe(false);
    expect(fs.readFileSync(filename)).toEqual(before);
    expect(inspectSchema(filename).version).toEqual({ user_version: 16 });
  });

  it.each(SQLITE_SIDECAR_SUFFIXES)(
    "preserves orphan %s without bootstrapping state",
    async (suffix) => {
      const env = freshEnvironment();
      const filename = resolveOpenClawStateSqlitePath(env);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      const sidecar = `${filename}${suffix}`;
      fs.writeFileSync(sidecar, "retained database family bytes");

      await expect(
        initializeUpdateStateFromTarget({
          ...initializationOptions(env),
          checkSchemas: async () => undefined,
        }),
      ).rejects.toThrow(/sidecar|missing|orphan/i);

      expect(mocks.doctor).not.toHaveBeenCalled();
      expect(fs.existsSync(filename)).toBe(false);
      expect(fs.readFileSync(sidecar, "utf8")).toBe("retained database family bytes");
    },
  );

  it.each([false, true])(
    "preserves pending recovery before initialization (displaced: %s)",
    async (displaced) => {
      const fixture = createRetainedCheckpointFixture(dirs.make("openclaw-update-recovery-"));
      if (displaced) {
        fixture.displace();
      }
      const filename = displaced ? fixture.displaced : fixture.file;
      const before = fs.readFileSync(filename);

      await expect(
        initializeUpdateStateFromTarget({
          ...initializationOptions(fixture.env),
          checkSchemas: async () => undefined,
        }),
      ).rejects.toThrow(/recovery|publication/i);

      expect(mocks.doctor).not.toHaveBeenCalled();
      expect(fs.readFileSync(filename)).toEqual(before);
      expect(fs.existsSync(fixture.file)).toBe(!displaced);
    },
  );

  it("lets the selected target create schema 16 before the parent records its update", async () => {
    const source = createTargetDatabase();
    const env = freshEnvironment();
    const filename = resolveOpenClawStateSqlitePath(env);
    const before = inspectSchema(source);
    mocks.doctor.mockImplementation(async () => {
      expect(fs.existsSync(filename)).toBe(false);
      publishTargetDatabase(source, env);
      return doctorSuccess;
    });

    await initializeUpdateStateFromTarget(initializationOptions(env));
    expect(inspectSchema(filename)).toEqual(before);
    const run = createUpdateRun({ trigger: "cli" }, { env });

    expect(mocks.doctor).toHaveBeenCalledOnce();
    const after = inspectSchema(filename);
    expect(after.version).toEqual(before.version);
    expect(after.metadata).toEqual(before.metadata);
    expect(after.schema.filter((row) => row.tbl_name !== "update_runs")).toEqual(
      before.schema.filter((row) => row.tbl_name !== "update_runs"),
    );
    expect(getUpdateRun(run.runId, { env })).toMatchObject({
      runId: run.runId,
      phase: "requested",
    });
  });

  it("runs target Doctor when package staging already initialized a compatible database", async () => {
    const env = freshEnvironment();
    const filename = publishTargetDatabase(createTargetDatabase(), env);
    const before = fs.readFileSync(filename);

    await initializeUpdateStateFromTarget(initializationOptions(env));

    expect(mocks.doctor).toHaveBeenCalledOnce();
    expect(fs.readFileSync(filename)).toEqual(before);
  });

  it("refuses failed target Doctor after package staging created a compatible database", async () => {
    const env = freshEnvironment();
    const filename = publishTargetDatabase(createTargetDatabase(), env);
    const before = fs.readFileSync(filename);
    mocks.doctor.mockResolvedValue({ ...doctorSuccess, exitCode: 1, stderrTail: "Invalid config" });

    await expect(initializeUpdateStateFromTarget(initializationOptions(env))).rejects.toThrow(
      "Invalid config",
    );

    expect(mocks.doctor).toHaveBeenCalledOnce();
    expect(fs.readFileSync(filename)).toEqual(before);
  });

  it("refuses a newer database created during staging without changing it", async () => {
    const env = freshEnvironment();
    expect(await updateStateNeedsInitialization(env)).toBe(true);
    const filename = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();
    const before = fs.readFileSync(filename);

    await expect(initializeUpdateStateFromTarget(initializationOptions(env))).rejects.toThrow(
      "Selected target cannot open the current database schema",
    );

    expect(mocks.doctor).not.toHaveBeenCalled();
    expect(fs.readFileSync(filename)).toEqual(before);
  });

  it("does not start Doctor when executor authority expires during schema inspection", async () => {
    const env = freshEnvironment();
    let current = true;
    await expect(
      initializeUpdateStateFromTarget({
        ...initializationOptions(env),
        async checkSchemas() {
          await checkTargetSchemas(env);
          current = false;
        },
        assertCurrent() {
          if (!current) {
            throw new Error("Update executor was revoked");
          }
        },
      }),
    ).rejects.toThrow("Update executor was revoked");

    expect(mocks.doctor).not.toHaveBeenCalled();
    expect(fs.existsSync(env.OPENCLAW_STATE_DIR)).toBe(false);
  });

  it.each([
    { label: "missing entrypoint", result: null },
    {
      label: "failed Doctor",
      result: { ...doctorSuccess, exitCode: 1, stderrTail: "Doctor failed" },
    },
    { label: "successful Doctor without a database", result: doctorSuccess },
  ])("refuses $label instead of letting the parent bootstrap state", async ({ result }) => {
    const env = freshEnvironment();
    mocks.doctor.mockResolvedValue(result);

    await expect(initializeUpdateStateFromTarget(initializationOptions(env))).rejects.toThrow();

    expect(fs.existsSync(resolveOpenClawStateSqlitePath(env))).toBe(false);
  });
});

describe("initialization schema coordination", () => {
  it("fences modern schema writers while the legacy target creates its database", async () => {
    const env = freshEnvironment();
    const databasePath = resolveOpenClawStateSqlitePath(env);
    const fence = acquireLegacyUpdateInitializationFence({
      env,
      targetVersion: "2026.7.1",
      targetSchemas: { state: 1, agent: 1 },
    });
    expect(fence).toBeDefined();
    // A separately loaded owner has no access to the parent's reentrant lease.
    vi.resetModules();
    const independent = await import("../../infra/state-database-coordinator.js");
    try {
      expect(() =>
        independent.withStateSchemaFence({ databasePath }, () => {
          throw new Error("Unexpected modern schema writer");
        }),
      ).toThrow("another Gateway owns that state directory");
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      const legacy = new DatabaseSync(databasePath);
      try {
        legacy.exec(
          "PRAGMA user_version=1; CREATE TABLE legacy_state(value TEXT); INSERT INTO legacy_state VALUES('target-owned')",
        );
      } finally {
        legacy.close();
      }
      const reader = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(reader.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
        expect(reader.prepare("SELECT value FROM legacy_state").get()).toEqual({
          value: "target-owned",
        });
      } finally {
        reader.close();
      }
    } finally {
      fence?.release();
    }
    expect(independent.withStateSchemaFence({ databasePath }, () => "released")).toBe("released");
  });

  it("leaves the modern target free to acquire its own schema fence", async () => {
    const env = freshEnvironment();
    const fence = acquireLegacyUpdateInitializationFence({
      env,
      targetVersion: "2026.9.2",
      targetSchemas,
    });
    try {
      vi.resetModules();
      const independent = await import("../../infra/state-database-coordinator.js");
      expect(
        independent.withStateSchemaFence(
          { databasePath: resolveOpenClawStateSqlitePath(env) },
          () => "target-owned",
        ),
      ).toBe("target-owned");
    } finally {
      fence?.release();
    }
  });
});
