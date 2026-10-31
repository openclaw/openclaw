import { expect, it, onTestFinished } from "vitest";
import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { worktreeRegistryPublication } from "./registry-publication.js";
import {
  insertRegistryWorktreeInDatabase,
  updateRegistryWorktreeInDatabase,
  type WorktreeRegistryPatch,
} from "./registry-run-end.worker.js";
import { makeWorktreeRecord } from "./service.test-support.js";
import { useWorktreeStateRoots } from "./state-fixture.test-support.js";

const dirs = useWorktreeStateRoots();

it("installs the whole committed registry batch before observers and discards savepoint/outer rollback", () => {
  const env = { ...process.env, OPENCLAW_STATE_DIR: dirs.make("worktree-publication-") };
  const database = openOpenClawStateDatabase({ env });
  const record = makeWorktreeRecord(env.OPENCLAW_STATE_DIR, "first", {
    path: `${env.OPENCLAW_STATE_DIR}/first`,
    ownerId: "agent:main:first",
  });
  const installed = new Map<string, unknown>();
  const observed: string[][] = [];
  const unsubscribeFacts = worktreeRegistryPublication.subscribeFacts((change) => {
    if (change.kind === "committed") {
      for (const [key, fact] of change.receipt.facts) {
        installed.set(key, fact);
      }
    }
  });
  onTestFinished(unsubscribeFacts);
  const observe = () =>
    deferSqlitePostCommitPublication(database.db, () => observed.push([...installed.keys()]));
  const write = (run: () => void) => runOpenClawStateWriteTransaction(run, { env, database });
  const update = (patch: WorktreeRegistryPatch) =>
    updateRegistryWorktreeInDatabase(database.db, { id: "first", patch });
  const expectFact = (value: object) =>
    expect(installed.get(keys[0]!)).toMatchObject({ kind: "postimage", value });
  const keys = ["first", "second"].map((id) => JSON.stringify(["worktrees", id]));
  const rollback = (message: string, patch: WorktreeRegistryPatch) =>
    expect(() =>
      write(() => {
        update(patch);
        observe();
        throw new Error(message);
      }),
    ).toThrow(message);
  write(() => {
    insertRegistryWorktreeInDatabase(database.db, { record });
    observe();
    rollback("rollback savepoint", { lastActiveAt: 2 });
    insertRegistryWorktreeInDatabase(database.db, {
      record: {
        ...record,
        id: "second",
        path: `${env.OPENCLAW_STATE_DIR}/second`,
        branch: "second",
      },
    });
    observe();
    expect(installed.size).toBe(0);
    expect(observed).toEqual([]);
  });
  expect(observed).toEqual([keys, keys]);
  expectFact({ last_active_at: 1 });
  rollback("rollback outer", { removedAt: 3 });
  expect(observed).toHaveLength(2);
  expectFact({ removed_at: null });
  installed.clear();
  const before = database.db.prepare("SELECT total_changes() AS count").get();
  write(() => update({ lastActiveAt: 1, removedAt: undefined, snapshotRef: undefined }));
  expect(database.db.prepare("SELECT total_changes() AS count").get()).toEqual(before);
  expect(installed.size).toBe(0);
  write(() => update({ snapshotRef: "refs/openclaw/snapshots/first" }));
  expectFact({ snapshot_ref: "refs/openclaw/snapshots/first" });
  write(() => update({ snapshotRef: undefined }));
  expectFact({ snapshot_ref: null });
});
