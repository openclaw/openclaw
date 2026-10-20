import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { ChildProcess } from "node:child_process";
import { tracingChannel } from "node:diagnostics_channel";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { createSpawnBrokerHost } from "../process/spawn-broker/host.js";
import { createDeferredCore } from "../shared/deferred.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { SQLITE_READONLY_CHILD_ARG } from "./runtime-process-entrypoints.js";
import { cleanupSnapshotOperations } from "./sqlite-readonly-location-cleanup.js";
import {
  createSqliteReadOnlyWorkerScope,
  runSqliteReadOnlyWorker,
} from "./sqlite-readonly-worker.js";
import { readDatabasePathIdentitySync } from "./sqlite-worker-identity.js";

const [root, transport] = process.argv.slice(2);
assert.ok(root, "SQLite retention fixture requires its temporary directory");
assert.ok(transport === "native" || transport === "broker");
const gc = globalThis.gc;
assert.ok(gc, "The retention child requires --expose-gc");
const source = path.join(root, "source.sqlite");
const store = {
  version: 1,
  profiles: { "fixture:default": { type: "api_key", provider: "fixture", key: "synthetic" } },
};
const state = { lastGood: { fixture: "fixture:default" } };
{
  using database = new (requireNodeSqlite().DatabaseSync)(source);
  for (const [table, raw] of [
    ["store", store],
    ["state", state],
  ] as const) {
    database.exec(
      `CREATE TABLE auth_profile_${table} (${table}_key TEXT PRIMARY KEY, ${table}_json TEXT)`,
    );
    database
      .prepare(`INSERT INTO auth_profile_${table} VALUES (?, ?)`)
      .run("primary", JSON.stringify(raw));
  }
}
const expected = {
  store: { status: "readable", raw: store },
  state: { status: "readable", raw: state },
  cacheable: true,
};
const readOptions = {
  mode: "auth-profile-rows",
  source: "canonical",
  expectedIdentity: readDatabasePathIdentitySync(source).key,
  env: { ...process.env },
} as const;

const scope = createSqliteReadOnlyWorkerScope();
const broker = transport === "broker" ? createSpawnBrokerHost() : undefined;
const callerContext = new AsyncLocalStorage<object>();
const read = () =>
  runWithSpawnBroker(broker, () => scope.run(() => runSqliteReadOnlyWorker(source, readOptions)));
const children: ChildProcess[] = [];
const observe = (message: unknown) => {
  if (
    isRecord(message) &&
    message.process instanceof ChildProcess &&
    message.process.spawnargs.includes(SQLITE_READONLY_CHILD_ARG)
  ) {
    children.push(message.process);
  }
};
const spawnChannel = tracingChannel("child_process.spawn").start;
spawnChannel.subscribe(observe);
if (broker) {
  const spawn = broker.spawn.bind(broker);
  broker.spawn = (...args) => {
    const child = spawn(...args);
    children.push(child);
    return child;
  };
}

async function completedRead(label: string) {
  const caller = { label, prompt: Buffer.alloc(1024 * 1024, label) };
  const references = [new WeakRef<object>(caller), new WeakRef<object>(caller.prompt)];
  await callerContext.run(caller, async () => {
    const result = await read();
    assert.deepEqual(result, expected);
    assert.equal(callerContext.getStore(), caller, "Request context must survive its own read");
    references.push(new WeakRef(result));
  });
  return references;
}

async function cancelledQueuedCaller() {
  const caller = { prompt: Buffer.alloc(1024 * 1024, "cancelled queue") };
  const references = [new WeakRef<object>(caller), new WeakRef<object>(caller.prompt)];
  await callerContext.run(caller, async () => {
    const queuedScope = createSqliteReadOnlyWorkerScope();
    const queued = runWithSpawnBroker(broker, () =>
      queuedScope.run(() => runSqliteReadOnlyWorker(source, readOptions)),
    );
    const rejected = assert.rejects(queued, /scope closed/);
    await queuedScope.close();
    await rejected;
  });
  return references;
}

try {
  await broker?.ready();
  const first = await completedRead("first");
  const worker = children[0];
  assert.ok(worker, "The first read must create the real scoped worker");
  const second = await completedRead("second");
  assert.equal(children.length, 1, "Unrelated requests must reuse the same worker");
  const control = new WeakRef({ unowned: true });
  for (let pass = 0; pass < 8; pass += 1) {
    await setImmediate();
    gc();
  }
  assert.equal(control.deref(), undefined, "Unowned control must collect");
  assert.deepEqual(
    [...first, ...second].map((ref) => ref.deref()),
    [undefined, undefined, undefined, undefined, undefined, undefined],
    "The live SQLite worker retained completed caller state",
  );
  assert.equal(worker.exitCode, null, "Collection must happen before worker retirement");
  assert.deepEqual(await read(), expected);
  assert.equal(children.length, 1, "The collected callers must leave the same worker reusable");
  const paused = createDeferredCore<() => boolean>();
  const originalEmit = worker.emit.bind(worker);
  let pause = true;
  worker.emit = function (event: string | symbol, ...args: unknown[]) {
    const message: unknown = args[0];
    if (
      event === "message" &&
      pause &&
      isRecord(message) &&
      isRecord(message.result) &&
      message.result.type === "start"
    ) {
      pause = false;
      paused.resolve(() => originalEmit.call(worker, event, ...args));
      return true;
    }
    return originalEmit.call(this, event, ...args);
  };
  const active = read();
  const release = await paused.promise;
  try {
    const cancelled = await cancelledQueuedCaller();
    for (let pass = 0; pass < 8; pass++) {
      await setImmediate();
      gc();
    }
    assert.deepEqual(
      cancelled.map((reference) => reference.deref()),
      [undefined, undefined],
      "An unrelated paused read retained the cancelled caller",
    );
    assert.equal(worker.exitCode, null, "Queued cancellation must leave the active child alive");
  } finally {
    release();
    worker.emit = originalEmit;
    await active;
  }
  process.stdout.write(
    JSON.stringify({ transport, collected: first.length + second.length, reused: true }),
  );
} finally {
  try {
    await scope.close();
    await cleanupSnapshotOperations();
    spawnChannel.unsubscribe(observe);
  } finally {
    await broker?.close();
  }
}
