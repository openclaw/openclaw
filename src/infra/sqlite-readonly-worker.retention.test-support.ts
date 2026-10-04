import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { createSpawnBrokerHost } from "../process/spawn-broker/host.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { readOnlyWorkerScope } from "./sqlite-readonly-worker-context.js";
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
const database = new (requireNodeSqlite().DatabaseSync)(source);
try {
  database.exec(`
    CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT);
    CREATE TABLE auth_profile_state (state_key TEXT PRIMARY KEY, state_json TEXT);
  `);
  database
    .prepare("INSERT INTO auth_profile_store VALUES (?, ?)")
    .run("primary", JSON.stringify(store));
  database
    .prepare("INSERT INTO auth_profile_state VALUES (?, ?)")
    .run("primary", JSON.stringify(state));
} finally {
  database.close();
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

// The lifecycle starts before either request, as it does at Gateway startup.
const scope = createSqliteReadOnlyWorkerScope();
const broker = transport === "broker" ? createSpawnBrokerHost() : undefined;
const callerContext = new AsyncLocalStorage<object>();
const read = () =>
  runWithSpawnBroker(broker, () => scope.run(() => runSqliteReadOnlyWorker(source, readOptions)));
const currentWorker = () => scope.run(() => readOnlyWorkerScope.getStore()?.readWorker?.session);

async function completedRead(label: string) {
  const caller = { label, prompt: Buffer.alloc(1024 * 1024, label) };
  const references = [
    { label: `${label} context`, reference: new WeakRef<object>(caller) },
    { label: `${label} prompt`, reference: new WeakRef<object>(caller.prompt) },
  ];
  await callerContext.run(caller, async () => {
    const result = await read();
    assert.deepEqual(result, expected);
    assert.equal(callerContext.getStore(), caller, "Request context must survive its own read");
    references.push({ label: `${label} result`, reference: new WeakRef(result) });
  });
  return references;
}

try {
  await broker?.ready();
  const first = await completedRead("first");
  const worker = currentWorker();
  assert.ok(worker, "The first read must create the real scoped worker");
  const second = await completedRead("second");
  assert.equal(currentWorker(), worker, "Unrelated requests must reuse the same worker");
  const control = new WeakRef({ unowned: true });
  for (let pass = 0; pass < 8; pass += 1) {
    await setImmediate();
    gc();
  }
  assert.equal(control.deref(), undefined, "Unowned control must collect");
  const retained = [...first, ...second]
    .filter(({ reference }) => reference.deref())
    .map(({ label }) => label);
  assert.deepEqual(retained, [], "The live SQLite worker retained completed caller state");
  assert.equal(worker.isRetired(), false, "Collection must happen before worker retirement");
  assert.deepEqual(await read(), expected);
  assert.equal(
    currentWorker(),
    worker,
    "The collected callers must leave the same worker reusable",
  );
  process.stdout.write(
    JSON.stringify({ transport, collected: first.length + second.length, reused: true }),
  );
} finally {
  try {
    await scope.close();
  } finally {
    await broker?.close();
  }
}
