import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHotSqliteRollbackJournal } from "../../test/helpers/sqlite-hot-journal.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import * as rollback from "./sqlite-rollback-recovery.js";
import { recoverManagedUpdateLeaseJournal } from "./update-managed-service-handoff-database-recovery.js";
import {
  captureManagedUpdateLeaseDatabaseIdentity,
  createManagedHandoffLeaseDatabase,
  type ManagedUpdateLeaseDatabaseIdentity,
} from "./update-managed-service-handoff-database.js";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
let databasePath: string;
let installKey: string;
let existingIdentity: ManagedUpdateLeaseDatabaseIdentity;
const dead = { pid: 2_147_483_647, startIdentity: "123" };
const original = () => ({
  version: 2,
  helper: dead,
  executor: dead,
  action: { kind: "update", mutationProtocol: "original-cancellation-v1" },
});
const recover = () =>
  recoverManagedUpdateLeaseJournal({ existingIdentity, installKey, serviceManagerEnv: {} });
const store = () =>
  createManagedHandoffLeaseStore({
    databasePath,
    existingIdentity,
    originalUpdateKey: installKey,
    serviceManagerEnv: {},
  });
const row = () => {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db.prepare("SELECT * FROM managed_update_handoffs").all();
  } finally {
    db.close();
  }
};
function seed(
  payload: unknown = original(),
  key = installKey,
  recovery: string | null = null,
): void {
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare(
      "INSERT INTO managed_update_handoffs (install_root,owner,payload_json,updated_at,recovery_json) VALUES (?, ?, ?, ?, ?)",
    ).run(key, "committed-owner", JSON.stringify(payload), 1, recovery);
  } finally {
    db.close();
  }
}
function crash(): void {
  createHotSqliteRollbackJournal({
    path: databasePath,
    mutationSql: "UPDATE managed_update_handoffs SET owner='uncommitted-owner'",
  });
}

beforeEach(() => {
  const directory = dirs.make("managed-update-cold-recovery-");
  installKey = path.join(directory, "installation");
  fs.mkdirSync(installKey);
  databasePath = path.join(directory, "lease.sqlite");
  createManagedHandoffLeaseDatabase(databasePath)(true, () => undefined);
  existingIdentity = captureManagedUpdateLeaseDatabaseIdentity(databasePath);
});
afterEach(() => vi.restoreAllMocks());

it("repairs a real cold rollback journal without deleting its committed owner, then ordinary acquisition reclaims it", async () => {
  seed();
  const committed = row();
  crash();
  expect(store().read(installKey)).toMatchObject({ kind: "unreadable", error: { errcode: 776 } });
  await recover();
  expect(row()).toEqual(committed);
  expect(fs.existsSync(`${databasePath}-journal`)).toBe(false);
  expect(captureManagedUpdateLeaseDatabaseIdentity(databasePath)).toEqual(existingIdentity);
  const next = store().acquire(installKey, "next-owner", { kind: "update" });
  expect(next.kind).toBe("acquired");
  if (next.kind === "acquired") {
    expect(store().release(next.lease)).toBe(true);
  }
});

it("admits an empty committed executor store after its interrupted transaction", async () => {
  crash();
  await recover();
  expect(row()).toEqual([]);
});

it.each(["live", "unknown"])(
  "preserves the hot source bytes when the original executor is %s",
  async (state) => {
    const actor =
      state === "live"
        ? { pid: process.pid, startIdentity: String(getFileLockProcessStartTime(process.pid)) }
        : dead;
    seed({ ...original(), helper: actor, executor: actor });
    crash();
    const before = [fs.readFileSync(databasePath), fs.readFileSync(`${databasePath}-journal`)];
    if (state === "unknown") {
      const kill = process.kill.bind(process);
      vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === dead.pid) {
          throw Object.assign(new Error("process access denied"), { code: "EPERM" });
        }
        return kill(pid, signal);
      });
    }
    await expect(recover()).rejects.toThrow("definitely dead original executor");
    expect([fs.readFileSync(databasePath), fs.readFileSync(`${databasePath}-journal`)]).toEqual(
      before,
    );
  },
);

it.each([
  "child",
  "foreign",
  "bound",
  "custody",
  "mirror",
  "version4",
  "unknown",
  "repair-metadata",
])("preserves %s custody for its original recovery owner", async (kind) => {
  let key = installKey;
  let payload: unknown = original();
  if (kind === "child") {
    key = `${installKey}/.openclaw-update-child-1`;
  }
  if (kind === "foreign") {
    key = `${installKey}-foreign`;
  }
  if (kind === "bound") {
    payload = { ...original(), executor: { ...dead, pid: dead.pid - 1 } };
  }
  if (kind === "custody") {
    payload = { ...original(), action: { ...original().action, custody: "bound" } };
  }
  if (kind === "mirror") {
    payload = {
      ...original(),
      mutationOriginal: {
        key: `${installKey}-original`,
        owner: "original-owner",
        payload: JSON.stringify(original()),
        updatedAt: 0,
      },
    };
  }
  if (kind === "version4") {
    payload = {
      ...original(),
      version: 4,
      cancellation: {
        key: installKey,
        owner: "committed-owner",
        payload: JSON.stringify(original()),
        updatedAt: 0,
      },
    };
  }
  if (kind === "unknown") {
    payload = { ...original(), futureWriter: true };
  }
  seed(payload, key, kind === "repair-metadata" ? "retained recovery metadata" : null);
  const before = row();
  await expect(recover()).rejects.toThrow("foreign or retained executor custody");
  expect(row()).toEqual(before);
});

it("refuses recovery after the prepared rollback journal changes", async () => {
  seed();
  crash();
  const mainBytes = fs.readFileSync(databasePath);
  const prepare = rollback.prepareSqliteRollbackRecovery;
  let changedJournal: Buffer | undefined;
  vi.spyOn(rollback, "prepareSqliteRollbackRecovery").mockImplementation(async (params) => {
    const prepared = await prepare(params);
    fs.appendFileSync(`${databasePath}-journal`, "changed after snapshot");
    changedJournal = fs.readFileSync(`${databasePath}-journal`);
    return prepared;
  });
  await expect(recover()).rejects.toThrow("database or journal changed");
  expect(fs.readFileSync(databasePath)).toEqual(mainBytes);
  expect(fs.readFileSync(`${databasePath}-journal`)).toEqual(changedJournal);
});
