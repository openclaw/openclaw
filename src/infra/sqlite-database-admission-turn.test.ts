import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, assert, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  runOpenClawAgentWorkerWrite as workerWrite,
  runOpenClawAgentWriteAdmission as write,
} from "../state/openclaw-agent-write-admission.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import {
  acquireSqliteDatabaseAdmissionTurn,
  runWithSqliteDatabaseAdmissionTurn,
} from "./sqlite-database-admission-turn.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "./sqlite-database-admission.js";
import { admitSqliteSchema } from "./sqlite-schema-facts.js";

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

function makeFixture(prefix: string) {
  const options = { agentId: "main", path: path.join(tempDirs.make(prefix), "agent.sqlite") };
  const entered = createDeferred();
  const release = createDeferred();
  const order: string[] = [];
  const hold = () => {
    entered.resolve();
    return release.promise;
  };
  const record = (value: string) => async () => {
    order.push(value);
  };
  return { options, entered, release, order, hold, record };
}

it("settles nested warm writes before cold followers after revocation", async ({ signal }) => {
  const { options, entered, release, hold, order, record } = makeFixture("warm-write-revocation-");
  using database = openNodeSqliteDatabase(options.path);
  database.exec("CREATE TABLE proof(value INTEGER)");
  admitSqliteSchema(database);
  const blocker = write(options, hold);
  await entered.promise;
  const outer = write(options, async () => {
    await workerWrite(options, record("nested"));
    order.push("outer");
  });
  revokeSqliteDatabaseAdmissionsForPath(options.path);
  const controller = new AbortController();
  const follower = write(options, record("follower"), false, undefined, controller.signal);
  try {
    release.resolve();
    await withinTest(Promise.all([outer, follower]), signal);
    expect(order).toEqual(["nested", "outer", "follower"]);
  } finally {
    controller.abort(new Error("test cleanup"));
    release.resolve();
    await Promise.allSettled([blocker, outer, follower]);
  }
});

it("retires warm scopes before detached children request cold writers", async ({ signal }) => {
  const { options, order, record } = makeFixture("warm-write-retired-scope-");
  using database = openNodeSqliteDatabase(options.path);
  database.exec("CREATE TABLE proof(value INTEGER)");
  admitSqliteSchema(database);
  const releaseChild = createDeferred();
  let child: Promise<void> | undefined;
  await runWithSqliteDatabaseAdmissionTurn([options.path], async () => {
    child = (async () => {
      await releaseChild.promise;
      await runWithSqliteDatabaseAdmissionTurn([options.path], record("child"));
    })();
  });
  revokeSqliteDatabaseAdmissionsForPath(options.path);
  const releaseCold = createDeferred();
  const coldEntered = createDeferred();
  const cold = runWithSqliteDatabaseAdmissionTurn([options.path], async () => {
    coldEntered.resolve();
    await releaseCold.promise;
    order.push("cold");
  });
  try {
    await withinTest(coldEntered.promise, signal);
    releaseChild.resolve();
    await setImmediate();
    expect(order).toEqual([]);
    releaseCold.resolve();
    await withinTest(Promise.all([cold, child]), signal);
    expect(order).toEqual(["cold", "child"]);
  } finally {
    releaseChild.resolve();
    releaseCold.resolve();
    await Promise.allSettled([cold, child]);
  }
});
