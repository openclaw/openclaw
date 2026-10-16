import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { worktreeRegistryPublication } from "./registry-publication.js";
import {
  insertRegistryWorktreeInDatabase,
  updateRegistryWorktreeInDatabase,
} from "./registry-run-end.worker.js";
import type { ManagedWorktreeRecord } from "./types.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseAsync());

it("installs the whole committed registry batch before observers and discards savepoint/outer rollback", () => {
  const env = { ...process.env, OPENCLAW_STATE_DIR: dirs.make("worktree-publication-") };
  const database = openOpenClawStateDatabase({ env });
  const record: ManagedWorktreeRecord = {
    id: "first",
    name: "first",
    repoFingerprint: "0123456789abcdef",
    repoRoot: env.OPENCLAW_STATE_DIR,
    path: `${env.OPENCLAW_STATE_DIR}/first`,
    branch: "first",
    baseRef: "HEAD",
    ownerKind: "session",
    ownerId: "agent:main:first",
    createdAt: 1,
    lastActiveAt: 1,
  };
  const installed = new Map<string, unknown>();
  const observed: string[][] = [];
  const unsubscribeFacts = worktreeRegistryPublication.subscribeFacts((change) => {
    if (change.kind === "committed") {
      for (const [key, fact] of change.receipt.facts) {
        installed.set(key, fact);
      }
    }
  });
  const observe = () =>
    deferSqlitePostCommitPublication(database.db, () => observed.push([...installed.keys()]));
  const write = (run: () => void) => runOpenClawStateWriteTransaction(run, { env, database });
  try {
    write(() => {
      insertRegistryWorktreeInDatabase(database.db, { record });
      observe();
      expect(() =>
        write(() => {
          updateRegistryWorktreeInDatabase(database.db, {
            id: "first",
            patch: { lastActiveAt: 2 },
          });
          observe();
          throw new Error("rollback savepoint");
        }),
      ).toThrow("rollback savepoint");
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
    const keys = [JSON.stringify(["worktrees", "first"]), JSON.stringify(["worktrees", "second"])];
    expect(observed).toEqual([keys, keys]);
    expect(installed.get(keys[0]!)).toMatchObject({
      kind: "postimage",
      value: { last_active_at: 1 },
    });
    expect(() =>
      write(() => {
        updateRegistryWorktreeInDatabase(database.db, { id: "first", patch: { removedAt: 3 } });
        observe();
        throw new Error("rollback outer");
      }),
    ).toThrow("rollback outer");
    expect(observed).toHaveLength(2);
    expect(installed.get(keys[0]!)).toMatchObject({
      kind: "postimage",
      value: { removed_at: null },
    });
  } finally {
    unsubscribeFacts();
  }
});
