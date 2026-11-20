import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { DatabasePortTask } from "../infra/database-engine/port-command.worker.js";
import {
  databasePortManifestPath,
  writeDatabasePortManifest,
  type DatabasePortManifest,
} from "../infra/database-port-recovery.js";
import * as filesystem from "../infra/sqlite-wal-filesystem.js";

const mocks = vi.hoisted(() => ({ task: vi.fn(), durable: "", configPath: "", config: {} }));
// mock-isolation: fixture-only custody must not admit or mutate the host state owner.
vi.mock("../cli/local-state-owner.js", () => ({
  runWithLocalStateOwner: async (options: { runLocal: (scope: unknown) => Promise<unknown> }) =>
    options.runLocal({
      env: process.env,
      signal: new AbortController().signal,
      assertCurrent() {},
    }),
}));
// mock-isolation: configuration reads must stay on the private fixture, never host configuration.
vi.mock("../config/io.js", () => ({
  readConfigFileSnapshotForWrite: async () => ({
    snapshot: { valid: true, path: mocks.configPath, config: mocks.config },
    writeOptions: {},
  }),
}));
vi.mock("../infra/database-engine/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/database-engine/config.js")>()),
  resolveDatabaseEngineInput: async () => ({
    connection: "postgres://synthetic.invalid/unused",
    schemaPrefix: "port_test",
  }),
}));
vi.mock("../infra/database-engine/port-command.worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/database-engine/port-command.worker.js")>()),
  runDatabasePortTask: mocks.task,
}));
vi.mock("./doctor-database-port-publication.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor-database-port-publication.js")>()),
  prepareStores: async () => {
    throw new Error("downstream publication held");
  },
}));
vi.mock("../infra/node-sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/node-sqlite.js")>();
  return {
    ...actual,
    openNodeSqliteDatabase: (...args: Parameters<typeof actual.openNodeSqliteDatabase>) => {
      if (mocks.durable && args[0].startsWith(mocks.durable + path.sep)) {
        throw new Error("SQLite SQL must stay off durable storage during working preparation");
      }
      return actual.openNodeSqliteDatabase(...args);
    },
  };
});

import { doctorDatabasePort } from "./doctor-database-port.js";

let root: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  mocks.task.mockReset();
  mocks.durable = "";
  if (root) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
const artifact = (file: string) => {
  const bytes = fs.readFileSync(file);
  return {
    path: file,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
};

it("keeps working SQL local and resumes durable bytes without early cleanup", async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "port-local-working-"));
  const state = path.join(root, "durable");
  const cache = path.join(root, "local-cache");
  fs.mkdirSync(state, { mode: 0o700 });
  fs.mkdirSync(cache, { mode: 0o700 });
  mocks.durable = state;
  mocks.configPath = path.join(root, "config.json");
  mocks.config = {
    database: { engine: "postgres", families: { agent: { engine: "sqlite" } } },
    plugins: { enabled: false },
  };
  fs.writeFileSync(mocks.configPath, JSON.stringify(mocks.config), { mode: 0o600 });
  vi.stubEnv("OPENCLAW_STATE_DIR", state);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", mocks.configPath);
  vi.stubEnv("XDG_CACHE_HOME", cache);
  const source = path.join(state, "main.sqlite");
  const db = new DatabaseSync(source);
  db.exec("CREATE TABLE witness(value TEXT); INSERT INTO witness VALUES ('original')");
  db.close();
  const operationId = randomUUID();
  const directory = path.join(state, "recovery", "database-port", operationId);
  fs.mkdirSync(path.join(directory, "0"), { recursive: true, mode: 0o700 });
  const image = path.join(directory, "0", "original.sqlite");
  fs.copyFileSync(source, image);
  fs.chmodSync(image, 0o600);
  const inputs = path.join(directory, "inputs.json");
  const sourceStat = fs.lstatSync(source, { bigint: true });
  fs.writeFileSync(
    inputs,
    JSON.stringify({
      stores: [
        {
          dev: String(sourceStat.dev),
          ino: String(sourceStat.ino),
          original: artifact(source),
          image,
        },
      ],
      selection: {
        path: ["database", "families", "agent", "engine"],
        originalValue: "sqlite",
        effectiveSource: "sqlite",
      },
      outOfScope: [],
    }),
    { mode: 0o600 },
  );
  const stateStat = fs.lstatSync(state, { bigint: true });
  const manifest: DatabasePortManifest = {
    version: 1,
    operationId,
    revision: 1,
    state: "preparing",
    root: { stateDir: state, dev: String(stateStat.dev), ino: String(stateStat.ino) },
    direction: { from: "sqlite", to: "postgres" },
    originalConfig: [artifact(mocks.configPath)],
    artifacts: [artifact(image), artifact(inputs)],
    targets: [
      {
        storeId: randomUUID(),
        sourceSchemaVersion: 1,
        targetSchemaVersion: 1,
        descriptorHash: "a".repeat(64),
        original: { engine: "sqlite", path: source },
        intended: { engine: "postgres", anchorPath: source, namespace: "port_test" },
        originalCapture: artifact(image),
        verification: null,
      },
    ],
  };
  writeDatabasePortManifest(state, manifest, () => {});
  const fixed = databasePortManifestPath(state);
  const original = artifact(image);
  const proof = { tables: { witness: { rows: 1, sha256: "b".repeat(64) } }, allocations: {} };
  let entered = Promise.withResolvers<string>();
  let release = Promise.withResolvers<void>();
  let fail = true;
  mocks.task.mockImplementation(async (task: DatabasePortTask) => {
    if (!("sourcePath" in task)) {
      throw new Error("unexpected worker operation");
    }
    expect(task.sourcePath.startsWith(cache + path.sep)).toBe(true);
    if (task.operation === "migrate") {
      using local = new DatabaseSync(task.sourcePath);
      local.exec("UPDATE witness SET value='canonical'");
    } else if (task.operation === "checkpoint") {
      using local = new DatabaseSync(task.sourcePath);
      local.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } else if (task.operation === "stage") {
      entered.resolve(task.sourcePath);
      await release.promise;
      if (fail) {
        throw new Error("stage fixture failed");
      }
      fs.writeFileSync(task.targetPath, "small synthetic PG anchor", { mode: 0o600 });
    }
    return { descriptorHash: "a".repeat(64), verification: proof };
  });
  const attempt = () =>
    doctorDatabasePort({ resume: fixed }).then(
      () => {
        throw new Error("fixture must stop before publication");
      },
      (error: unknown) => {
        if (!(error instanceof Error)) {
          throw error;
        }
        return error;
      },
    );
  const policy = vi.spyOn(filesystem, "resolvePathJournalPolicy").mockReturnValue("rollback");
  expect((await attempt()).message).toContain("XDG_CACHE_HOME on a local filesystem");
  expect(mocks.task).not.toHaveBeenCalled();
  expect(artifact(image)).toEqual(original);
  policy.mockRestore();
  const first = attempt();
  const firstLocal = await Promise.race([
    entered.promise,
    first.then((error) => {
      throw error;
    }),
  ]);
  expect(fs.existsSync(firstLocal)).toBe(true);
  const recorded = JSON.parse(fs.readFileSync(fixed, "utf8")).artifacts.find(
    (value: { path: string }) => path.basename(value.path).startsWith("working-"),
  );
  expect(artifact(recorded.path)).toEqual(recorded);
  expect(fs.readFileSync(recorded.path)).toEqual(fs.readFileSync(firstLocal));
  release.resolve();
  expect(await first).toBeInstanceOf(Error);
  expect(fs.existsSync(firstLocal)).toBe(true);
  expect(artifact(image)).toEqual(original);

  entered = Promise.withResolvers<string>();
  release = Promise.withResolvers<void>();
  fail = false;
  const second = attempt();
  const secondLocal = await Promise.race([
    entered.promise,
    second.then((error) => {
      throw error;
    }),
  ]);
  expect(secondLocal).not.toBe(firstLocal);
  expect(fs.existsSync(secondLocal)).toBe(true);
  expect(fs.readFileSync(secondLocal)).toEqual(fs.readFileSync(recorded.path));
  release.resolve();
  expect(await second).toBeInstanceOf(Error);
  const staged = JSON.parse(fs.readFileSync(fixed, "utf8"));
  expect(staged.targets[0].verification).toMatchObject({ rowCount: 1, ownerAdmitted: true });
  expect(
    staged.artifacts.some((value: { path: string }) => value.path.endsWith("/verification.json")),
  ).toBe(true);
  expect(fs.existsSync(secondLocal)).toBe(false);
  expect(fs.existsSync(firstLocal)).toBe(true);
  expect(mocks.task.mock.calls.filter(([task]) => task.operation === "migrate")).toHaveLength(1);
  expect(artifact(image)).toEqual(original);
});
