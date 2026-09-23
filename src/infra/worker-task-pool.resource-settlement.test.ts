import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { getManagedChildCommandPid } from "../../scripts/lib/managed-child-process.mts";
import { createManagedHandoffTestBinding } from "../../test/helpers/managed-handoff-isolation.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const poolUrl = new URL("./worker-task-pool.ts", import.meta.url).href;
const coordinatorUrl = new URL("./state-database-coordinator.ts", import.meta.url).href;
const ownershipUrl = new URL("./vitest-resource-ownership.ts", import.meta.url).href;

it.for(["close", "rotate"] as const)(
  "retains artifacts and retries native-exit publication when pool %s fails",
  async (operation, { signal }) => {
    const root = dirs.make("pool-native-exit-retry-");
    const binding = createManagedHandoffTestBinding(root);
    const workerPath = path.join(root, "worker.mts");
    fs.writeFileSync(
      workerPath,
      [
        'import { DatabaseSync } from "node:sqlite";',
        'import path from "node:path";',
        'import { parentPort } from "node:worker_threads";',
        `import { acquireStateDatabaseHandleLease } from ${JSON.stringify(coordinatorUrl)};`,
        "parentPort.on('message', ({ taskId, input: root }) => {",
        "  const databasePath = path.join(root, 'store.sqlite');",
        "  const lease = acquireStateDatabaseHandleLease({ databasePath });",
        "  const db = new DatabaseSync(databasePath);",
        "  db.exec(\"CREATE TABLE IF NOT EXISTS entries(value TEXT); INSERT INTO entries VALUES ('committed')\");",
        "  parentPort.postMessage({ taskId, status: 'ok', value: db.prepare('SELECT value FROM entries').all() });",
        "  // Termination closes the native handles, without executing a successful JS closer.",
        "  globalThis.retained = { db, lease };",
        "});",
      ].join("\n"),
    );
    const program = path.join(root, "probe.mjs");
    fs.writeFileSync(
      program,
      [
        'import assert from "node:assert/strict";',
        'import fs from "node:fs";',
        'import path from "node:path";',
        'import { mock } from "node:test";',
        'import { pathToFileURL } from "node:url";',
        'import { Worker } from "node:worker_threads";',
        `import { WorkerTaskPool } from ${JSON.stringify(poolUrl)};`,
        `import { findVitestResourceOwner } from ${JSON.stringify(ownershipUrl)};`,
        `const root = ${JSON.stringify(root)};`,
        `const operation = ${JSON.stringify(operation)};`,
        "const owner = findVitestResourceOwner(root);",
        "assert(owner);",
        "const mkdir = mock.method(fs, 'mkdirSync');",
        "const releaseGeneral = owner.claim();",
        "const generalClaim = mkdir.mock.calls.at(-1).arguments[0];",
        "mkdir.mock.restore();",
        "const workers = new Map();",
        "const postMessage = Worker.prototype.postMessage;",
        "const messages = mock.method(Worker.prototype, 'postMessage', function(...args) {",
        "  if (args[0]?.input === root && !workers.has(this)) workers.set(this, owner.observeNativeWorkerExit(this));",
        "  return Reflect.apply(postMessage, this, args);",
        "});",
        "const scratch = path.join(root, 'worker-artifacts');",
        "fs.mkdirSync(scratch);",
        "let released = 0;",
        "const pool = new WorkerTaskPool({",
        `  workerUrl: pathToFileURL(${JSON.stringify(workerPath)}),`,
        "  maxWorkers: 1, idleTimeoutMs: 0,",
        "  prepareWorker: () => ({ options: {}, temporaryDirectory: scratch, releaseResources: async () => { released++; } }),",
        "});",
        "const keepAlive = setInterval(() => {}, 1000);",
        "const write = fs.writeFileSync;",
        "let refused = 0;",
        "const receipts = mock.method(fs, 'writeFileSync', function(file, ...args) {",
        "  if (path.basename(String(file)) === 'native-exited') {",
        "    refused++;",
        "    throw new Error('injected receipt publication failure');",
        "  }",
        "  return Reflect.apply(write, this, [file, ...args]);",
        "});",
        "try {",
        "  assert.deepEqual(await pool.run(root, {}), [{ value: 'committed' }]);",
        "  await assert.rejects(pool[operation](), /native Worker exit/);",
        "  assert(refused > 0, 'native exit publication was not attempted');",
        "  assert.equal(workers.size, 1);",
        "  assert.equal([...workers.keys()][0].threadId, -1, 'real native exit must precede receipt publication');",
        "  assert(fs.existsSync(scratch), 'failed receipt discarded worker artifacts');",
        "  assert.equal(released, 0, 'failed receipt released resource custody');",
        "  const registry = path.join(owner.root, '.vitest-resource-owner', 'claims');",
        "  const nativeClaims = fs.readdirSync(registry).map(id => path.join(registry, id)).filter(claim => {",
        "    try { return fs.readFileSync(path.join(claim, 'native-worker'), 'utf8').startsWith(process.pid + ':'); }",
        "    catch (error) { if (error.code === 'ENOENT') return false; throw error; }",
        "  });",
        "  assert(nativeClaims.length > 0, 'no native lease was admitted');",
        "  for (const claim of nativeClaims) {",
        "    assert(!fs.existsSync(path.join(claim, 'released')), 'termination forged successful close');",
        "    assert(!fs.existsSync(path.join(claim, 'native-exited')), 'failed publication was discarded');",
        "  }",
        "  receipts.mock.restore();",
        "  await pool[operation]();",
        "  assert.equal(released, 1);",
        "  assert(!fs.existsSync(scratch));",
        "  for (const claim of nativeClaims) {",
        "    const nativeOwner = fs.readFileSync(path.join(claim, 'native-worker'), 'utf8');",
        "    assert.equal(fs.readFileSync(path.join(claim, 'native-exited'), 'utf8'), owner.identity + ':' + path.basename(claim) + ':' + nativeOwner);",
        "    assert(!fs.existsSync(path.join(claim, 'released')), 'native exit is not successful close');",
        "  }",
        "  assert(!fs.existsSync(path.join(generalClaim, 'released')));",
        "  assert(!fs.existsSync(path.join(generalClaim, 'native-exited')));",
        "  process.stdout.write('pool-native-exit-retry-verified');",
        "} finally {",
        "  receipts.mock.restore();",
        "  messages.mock.restore();",
        "  try {",
        "    await pool.close().catch(() => undefined);",
        "    // An independent observer joins even the deliberately failing baseline.",
        "    for (const [worker, settle] of workers) { await worker.terminate(); await settle(); }",
        "  } finally {",
        "    clearInterval(keepAlive);",
        "    releaseGeneral();",
        "  }",
        "}",
      ].join("\n"),
    );
    const result = await runNodeScript(
      [binding.nodeOption, "--import", "tsx", program],
      process.env,
      undefined,
      {
        signal,
        requireProcessTreeExit: process.platform !== "win32",
        onReady(child) {
          if (process.platform === "win32") {
            expect(getManagedChildCommandPid(child)).toBeUndefined();
          }
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toBe("pool-native-exit-retry-verified");
    binding.assertPath();
  },
);
