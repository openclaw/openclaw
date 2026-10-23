import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { preflightOpenClawDatabaseSchemas } from "../../state/openclaw-database-preflight.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { removePreparedWorkerOwnershipColumns } from "../../state/openclaw-state-schema-v17.test-support.js";
import { execNodeEvalSync } from "../../test-utils/node-process.js";

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
let env: NodeJS.ProcessEnv;
let filename: string;
type Options = Parameters<typeof initializeUpdateStateFromTarget>[0];
const initialize = (overrides: Partial<Options> = {}) =>
  initializeUpdateStateFromTarget({
    root: "/selected-target",
    timeoutMs: 5_000,
    progress: {},
    env,
    assertCurrent() {},
    checkSchemas: () => checkTargetSchemas(env),
    ...overrides,
  });

function freshEnvironment() {
  const root = dirs.make("openclaw-update-initialization-");
  return { HOME: root, OPENCLAW_STATE_DIR: path.join(root, "profile") };
}
beforeEach(() => {
  mocks.doctor.mockReset().mockResolvedValue(doctorSuccess);
  env = freshEnvironment();
  filename = resolveOpenClawStateSqlitePath(env);
});
afterEach(() => closeOpenClawStateDatabaseForTest());

function runIndependentSchemaWriter(value: string) {
  const params = { databasePath: filename };
  return execNodeEvalSync(
    `import {
      StateSchemaMutationConflictError,
      withStateDatabaseSchemaMaintenance,
    } from ${JSON.stringify(new URL("../../infra/state-database-maintenance.ts", import.meta.url).href)};
    try {
      console.log(withStateDatabaseSchemaMaintenance(${JSON.stringify(params)}, () => ${JSON.stringify(value)}));
    } catch (error) {
      if (!(error instanceof StateSchemaMutationConflictError)) throw error;
      console.log(error.message);
    }`,
    {
      imports: ["tsx"],
      env: {
        ...env,
        USERPROFILE: process.env.USERPROFILE,
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
      },
      timeout: 20_000,
    },
  ).trim();
}

function withDatabase(file: string, use: (db: DatabaseSync) => void, readOnly = false) {
  using db = new DatabaseSync(file, { readOnly });
  use(db);
}

let targetDatabaseBytes: Buffer | undefined;
async function publishTargetDatabase() {
  if (!targetDatabaseBytes) {
    const file = openOpenClawStateDatabase({ env: freshEnvironment() }).path;
    await closeOpenClawStateDatabaseAsync();
    withDatabase(file, (db) => {
      removePreparedWorkerOwnershipColumns(db);
      db.exec(
        "PRAGMA user_version=16; UPDATE schema_meta SET schema_version=16, app_version='2026.9.2'",
      );
    });
    targetDatabaseBytes = fs.readFileSync(file);
  }
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, targetDatabaseBytes);
  return fs.readFileSync(filename);
}

async function checkTargetSchemas(selectedEnv: NodeJS.ProcessEnv) {
  const result = await preflightOpenClawDatabaseSchemas({
    env: selectedEnv,
    supportedVersions: targetSchemas,
  });
  if (result.incompatible.length || result.indeterminate.length) {
    throw new Error("Selected target cannot open the current database schema");
  }
}

it("preserves an orphan journal without bootstrapping state", async () => {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const sidecar = `${filename}-journal`;
  fs.writeFileSync(sidecar, "retained database family bytes");
  await expect(initialize({ checkSchemas: async () => undefined })).rejects.toThrow(
    /sidecar|missing|orphan/i,
  );
  expect(mocks.doctor).not.toHaveBeenCalled();
  expect(fs.existsSync(filename)).toBe(false);
  expect(fs.readFileSync(sidecar, "utf8")).toBe("retained database family bytes");
});

it.each([
  { label: "nonzero exit", completion: { exitCode: 1 }, staged: true },
  { label: "zero-exit timeout", completion: { exitCode: 0, termination: "timeout" }, staged: true },
  {
    label: "zero-exit output limit",
    completion: { exitCode: 0, outputLimitExceeded: true },
    staged: true,
  },
  { label: "missing entrypoint", completion: null, staged: false },
  { label: "successful Doctor without a database", completion: {}, staged: false },
])("refuses target Doctor $label without parent bootstrap", async ({ completion, staged }) => {
  const before = staged ? await publishTargetDatabase() : undefined;
  mocks.doctor.mockResolvedValue(
    completion && {
      ...doctorSuccess,
      ...completion,
      ...(staged ? { stderrTail: "Invalid config" } : {}),
    },
  );
  const outcome = expect(initialize()).rejects;
  if (staged) {
    await outcome.toThrow("Invalid config");
    expect(mocks.doctor).toHaveBeenCalledOnce();
    expect(fs.readFileSync(filename)).toEqual(before);
  } else {
    await outcome.toThrow();
    expect(fs.existsSync(filename)).toBe(false);
  }
});

it("does not start Doctor when executor authority expires during schema inspection", async () => {
  let current = true;
  await expect(
    initialize({
      async checkSchemas() {
        await checkTargetSchemas(env);
        current = false;
      },
      assertCurrent() {
        assert(current, "Update executor was revoked");
      },
    }),
  ).rejects.toThrow("Update executor was revoked");
  expect(mocks.doctor).not.toHaveBeenCalled();
  expect(fs.existsSync(env.OPENCLAW_STATE_DIR!)).toBe(false);
});

it.each([
  { targetVersion: "2026.7.1", schemas: { state: 1, agent: 1 }, legacy: true },
  { targetVersion: "2026.9.2", schemas: targetSchemas, legacy: false },
])(
  "coordinates schema ownership for target $targetVersion",
  async ({ targetVersion, schemas, legacy }) => {
    const fence = acquireLegacyUpdateInitializationFence({
      env,
      targetVersion,
      targetSchemas: schemas,
    });
    try {
      if (!legacy) {
        expect(runIndependentSchemaWriter("target-owned")).toBe("target-owned");
        return;
      }
      assert(fence, "Legacy target requires an initialization fence");
      expect(runIndependentSchemaWriter("Unexpected modern schema writer")).toContain(
        "another Gateway owns that state directory",
      );
      mocks.doctor.mockImplementation(async () => {
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        withDatabase(filename, (db) => {
          db.exec(
            "PRAGMA user_version=1; CREATE TABLE legacy_state(value TEXT); INSERT INTO legacy_state VALUES('target-owned')",
          );
        });
        return doctorSuccess;
      });
      await fence.run(async () => {
        await Promise.resolve();
        await initialize({
          assertCurrent: fence.assertCurrent,
          checkSchemas: async () => undefined,
        });
      });
      expect(mocks.doctor).toHaveBeenCalledOnce();
      await expect(updateStateNeedsInitialization(env)).rejects.toThrow(
        "without an active schema lease or maintenance scope",
      );
      withDatabase(
        filename,
        (reader) => {
          expect(reader.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
          expect(reader.prepare("SELECT value FROM legacy_state").get()).toEqual({
            value: "target-owned",
          });
        },
        true,
      );
    } finally {
      await fence?.release();
    }
    expect(runIndependentSchemaWriter("released")).toBe("released");
  },
);
