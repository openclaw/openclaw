import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHotSqliteRollbackJournal } from "../../test/helpers/sqlite-hot-journal.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  resolvePackageActivationAnchor,
  resolvePackageActivationControl,
} from "./package-update-activation-paths.js";
import { withImmutableUpdateOwner } from "./update-immutable-owner.js";
import { createManagedHandoffLeaseDatabase } from "./update-managed-service-handoff-database.js";

const mocks = vi.hoisted(() => ({
  executor:
    vi.fn<
      typeof import("../cli/update-cli/update-command-executor.js").withUpdateCommandExecutor
    >(),
}));
vi.mock("../cli/update-cli/update-command-executor.js", () => ({
  withUpdateCommandExecutor: mocks.executor,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let control: string;
beforeEach(() => {
  mocks.executor.mockReset().mockImplementation(async (_runId, operation) =>
    operation({
      enter: async () => ({ assertCurrent: () => {} }),
    }),
  );
  const parent = fs.realpathSync(dirs.make("immutable-executor-"));
  root = path.join(parent, "installation");
  control = resolvePackageActivationControl(resolvePackageActivationAnchor(root));
  fs.mkdirSync(root, { mode: 0o755 });
  fs.mkdirSync(control, { mode: 0o755 });
  // Only adoption's control owner needs root projection. The native lease store
  // keeps its real caller-owned private directory, file, schema and identities.
  const lstat = fs.lstatSync;
  vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
    const stat = lstat(...args);
    if (stat && String(args[0]) === control) {
      Object.defineProperty(stat, "uid", { value: typeof stat.uid === "bigint" ? 0n : 0 });
    }
    return stat;
  });
});
afterEach(() => vi.restoreAllMocks());

it("reuses native executor storage beside control across later update and recovery invocations", async () => {
  await withImmutableUpdateOwner(root, async () => undefined);
  const first = mocks.executor.mock.calls[0]?.[2]?.existingAuthority;
  expect(first).toMatchObject({
    databasePath: path.join(control, "executor", "lease.sqlite"),
    installKey: root,
  });
  if (!first) {
    throw new Error("Missing native executor binding");
  }
  const stat = fs.lstatSync(first.databasePath, { bigint: true });
  expect(first.databaseIdentity).toBe(`${stat.dev}:${stat.ino}`);
  const db = new DatabaseSync(first.databasePath, { readOnly: true });
  try {
    expect(
      db.prepare("SELECT name FROM sqlite_schema WHERE name = 'managed_update_handoffs'").get(),
    ).toMatchObject({ name: "managed_update_handoffs" });
  } finally {
    db.close();
  }

  await withImmutableUpdateOwner(root, async () => undefined);
  expect(mocks.executor.mock.calls[1]?.[2]?.existingAuthority).toEqual(first);
  const retained = { ...first, owner: "retained-synthetic-executor" };
  await withImmutableUpdateOwner(root, async () => undefined, retained);
  expect(mocks.executor.mock.calls[2]?.[2]?.existingAuthority).toEqual(retained);
  expect(fs.lstatSync(first.databasePath, { bigint: true }).ino).toBe(stat.ino);
});

it("refuses a retained executor locator outside the installation control before admission", async () => {
  await withImmutableUpdateOwner(root, async () => undefined);
  const first = mocks.executor.mock.calls[0]?.[2]?.existingAuthority;
  if (!first) {
    throw new Error("Missing native executor binding");
  }
  await expect(
    withImmutableUpdateOwner(root, async () => undefined, {
      ...first,
      databasePath: path.join(control, "foreign.sqlite"),
      owner: "retained-synthetic-executor",
    }),
  ).rejects.toThrow("does not match its installation control");
  expect(mocks.executor).toHaveBeenCalledOnce();
  expect(fs.existsSync(path.join(control, "foreign.sqlite"))).toBe(false);
});

it("requires explicit recovery before an existing executor journal can be replayed", async () => {
  await withImmutableUpdateOwner(root, async () => undefined);
  const authority = mocks.executor.mock.calls[0]?.[2]?.existingAuthority;
  if (!authority) {
    throw new Error("Missing native executor binding");
  }
  createHotSqliteRollbackJournal({ path: authority.databasePath, mutationSql: "SELECT 1" });
  const before = [
    fs.readFileSync(authority.databasePath),
    fs.readFileSync(`${authority.databasePath}-journal`),
  ];
  mocks.executor.mockImplementation(async (_runId, operation, options) => {
    const binding = options?.existingAuthority;
    if (!binding) {
      throw new Error("Recovery omitted its pinned native lease");
    }
    createManagedHandoffLeaseDatabase(binding.databasePath, binding)(false, (db) => {
      expect(db.prepare("SELECT count(*) AS count FROM managed_update_handoffs").get()?.count).toBe(
        0,
      );
    });
    return operation({ enter: async () => ({ assertCurrent: () => {} }) });
  });
  const continuation = vi.fn(async () => "recovered");
  await expect(withImmutableUpdateOwner(root, continuation)).rejects.toMatchObject({
    errcode: 776,
  });
  expect(continuation).not.toHaveBeenCalled();
  expect([
    fs.readFileSync(authority.databasePath),
    fs.readFileSync(`${authority.databasePath}-journal`),
  ]).toEqual(before);
  await expect(
    withImmutableUpdateOwner(root, continuation, undefined, { recover: true }),
  ).resolves.toBe("recovered");
  expect(continuation).toHaveBeenCalledOnce();
  expect(fs.existsSync(`${authority.databasePath}-journal`)).toBe(false);
  expect(mocks.executor.mock.calls.at(-1)?.[2]?.existingAuthority).toEqual(authority);
});
