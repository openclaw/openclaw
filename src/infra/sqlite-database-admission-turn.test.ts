import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, assert, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  acquireSqliteDatabaseAdmissionTurn,
  runWithSqliteDatabaseAdmissionTurn,
} from "./sqlite-database-admission-turn.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("keeps a canceled middle admission behind its predecessor for the next caller", async () => {
  const location = path.join(tempDirs.make("sqlite-admission-turn-"), "cold.sqlite");
  const release = await acquireSqliteDatabaseAdmissionTurn(location);
  assert(release);
  const controller = new AbortController();
  const canceled = vi.fn(async () => {});
  const successor = vi.fn(async () => {});
  const reason = new Error("queued admission canceled");
  const middle = runWithSqliteDatabaseAdmissionTurn([location], canceled, [], controller.signal);
  const rejected = expect(middle).rejects.toBe(reason);
  controller.abort(reason);
  let last: Promise<void> | undefined;
  try {
    await rejected;
    last = runWithSqliteDatabaseAdmissionTurn([location], successor);
    // Let queued promise continuations run while the first admission still owns its turn.
    await setImmediate();
    expect(canceled).not.toHaveBeenCalled();
    expect(successor).not.toHaveBeenCalled();
  } finally {
    release();
    await last;
  }
  expect(successor).toHaveBeenCalledOnce();
});
