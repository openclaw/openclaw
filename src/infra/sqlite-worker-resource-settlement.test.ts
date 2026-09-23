import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { getManagedChildCommandPid } from "../../scripts/lib/managed-child-process.mts";
import { createManagedHandoffTestBinding } from "../../test/helpers/managed-handoff-isolation.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const brokerUrl = new URL("./sqlite-worker-broker.ts", import.meta.url).href;
const coordinatorUrl = new URL("./state-database-coordinator.ts", import.meta.url).href;
const ownershipUrl = new URL("./vitest-resource-ownership.ts", import.meta.url).href;

it.for(
  (["close-failure", "factory-failure"] as const).flatMap((mode) =>
    (["broker", "generation"] as const).map((scope) => ({ mode, scope })),
  ),
)(
  "retains and retries native-exit receipts after $mode in $scope scope",
  async ({ mode, scope }, { signal }) => {
    const root = dirs.make("sqlite-native-exit-retry-");
    const binding = createManagedHandoffTestBinding(root);
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    const backend = path.join(root, "backend.ts");
    fs.writeFileSync(
      backend,
      [
        'import { DatabaseSync } from "node:sqlite";',
        `import { acquireStateDatabaseHandleLease } from ${JSON.stringify(coordinatorUrl)};`,
        "export function createSqliteWorkerBackend(mode, { databasePath }) {",
        "  const lease = acquireStateDatabaseHandleLease({ databasePath });",
        '  if (mode === "factory-failure") throw new Error("injected factory failure");',
        "  const db = new DatabaseSync(databasePath);",
        "  db.exec(\"CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES ('committed')\");",
        "  return {",
        '    execute() { return db.prepare("SELECT value FROM entries").all(); },',
        "    close() {",
        "      db.close();",
        '      if (mode === "close-failure") throw new Error("injected close failure");',
        "      lease.release();",
        "    },",
        "  };",
        "}",
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
        `import { SqliteWorkerBroker } from ${JSON.stringify(brokerUrl)};`,
        `import { findVitestResourceOwner } from ${JSON.stringify(ownershipUrl)};`,
        `const root = ${JSON.stringify(root)};`,
        `const mode = ${JSON.stringify(mode)};`,
        `const scope = ${JSON.stringify(scope)};`,
        "const owner = findVitestResourceOwner(root);",
        "assert(owner);",
        "const mkdir = mock.method(fs, 'mkdirSync');",
        "const releaseGeneral = owner.claim();",
        "const generalClaim = mkdir.mock.calls.at(-1).arguments[0];",
        "mkdir.mock.restore();",
        "const workers = new Map();",
        "const postMessage = Worker.prototype.postMessage;",
        "const messages = mock.method(Worker.prototype, 'postMessage', function(...args) {",
        "  if (args[0]?.type === 'open' && !workers.has(this)) workers.set(this, owner.observeNativeWorkerExit(this));",
        "  return Reflect.apply(postMessage, this, args);",
        "});",
        "const broker = new SqliteWorkerBroker();",
        "function generation() {",
        "  const owners = new Map();",
        "  return { resolve: url => url, retain: (owner, close) => owners.set(owner, close),",
        "    close: () => Promise.all([...owners.values()].map(close => close())) };",
        "}",
        "const current = generation();",
        "const sibling = generation();",
        "const close = () => scope === 'generation' ? current.close() : broker.close();",
        "const registry = path.join(owner.root, '.vitest-resource-owner', 'claims');",
        "function claims() {",
        "  return fs.readdirSync(registry).map(id => path.join(registry, id)).filter(claim => {",
        "    try { return fs.readFileSync(path.join(claim, 'native-worker'), 'utf8').startsWith(process.pid + ':'); }",
        "    catch (error) { if (error.code === 'ENOENT') return false; throw error; }",
        "  });",
        "}",
        "const keepAlive = setInterval(() => {}, 1000);",
        "const write = fs.writeFileSync;",
        "let refused = 0;",
        "const receipts = mock.method(fs, 'writeFileSync', function(file, ...args) {",
        '  if (path.basename(String(file)) === "native-exited") {',
        "    refused++;",
        '    throw new Error("injected receipt publication failure");',
        "  }",
        "  return Reflect.apply(write, this, [file, ...args]);",
        "});",
        "try {",
        "  let siblingClaims = [];",
        "  if (scope === 'generation') {",
        `    await assert.rejects(broker.open({ moduleUrl: pathToFileURL(${JSON.stringify(backend)}), databasePath: path.join(root, "sibling.sqlite"), input: 'factory-failure', runtimeGeneration: sibling }), /factory failure|cleanup failed|native Worker exit/);`,
        "    siblingClaims = claims();",
        "    assert(siblingClaims.length > 0, 'sibling generation admitted no native lease');",
        "  }",
        `  const opened = broker.open({ moduleUrl: pathToFileURL(${JSON.stringify(backend)}), databasePath: path.join(root, "store.sqlite"), input: mode, runtimeGeneration: scope === 'generation' ? current : undefined });`,
        '  if (mode === "factory-failure") {',
        "    await assert.rejects(opened, /factory failure|cleanup failed|native Worker exit/);",
        "  } else {",
        "    const store = await opened;",
        "    assert(store);",
        "    assert.deepEqual(await store.execute({ type: 'read', input: undefined }), [{ value: 'committed' }]);",
        "    await assert.rejects(store.close(), /close failure|cleanup failed|native Worker exit/);",
        "  }",
        "  await assert.rejects(close(), /cleanup failed|native Worker exit/);",
        "  assert(refused > 0, 'native receipt publication was not attempted');",
        "  const nativeClaims = claims().filter(claim => !siblingClaims.includes(claim));",
        "  assert(nativeClaims.length > 0, 'no native lease was admitted');",
        "  for (const claim of nativeClaims) {",
        "    assert(!fs.existsSync(path.join(claim, 'released')), 'failure forged successful native close');",
        "    assert(!fs.existsSync(path.join(claim, 'native-exited')), 'failed publication was discarded');",
        "  }",
        "  receipts.mock.restore();",
        "  await close();",
        "  for (const claim of nativeClaims) {",
        "    const nativeOwner = fs.readFileSync(path.join(claim, 'native-worker'), 'utf8');",
        "    assert.equal(fs.readFileSync(path.join(claim, 'native-exited'), 'utf8'), owner.identity + ':' + path.basename(claim) + ':' + nativeOwner);",
        "    assert(!fs.existsSync(path.join(claim, 'released')), 'native exit is not successful close');",
        "  }",
        "  for (const claim of siblingClaims) {",
        "    assert(!fs.existsSync(path.join(claim, 'native-exited')), 'generation cleanup settled a sibling receipt');",
        "    assert(!fs.existsSync(path.join(claim, 'released')), 'generation cleanup released a sibling claim');",
        "  }",
        "  if (scope === 'generation') {",
        "    await sibling.close();",
        "    for (const claim of siblingClaims) assert(fs.existsSync(path.join(claim, 'native-exited')));",
        "  }",
        "  assert(!fs.existsSync(path.join(generalClaim, 'released')));",
        "  assert(!fs.existsSync(path.join(generalClaim, 'native-exited')));",
        "  process.stdout.write('native-exit-retry-verified');",
        "} catch (error) {",
        "  fs.writeSync(2, String(error.stack ?? error));",
        "  throw error;",
        "} finally {",
        "  receipts.mock.restore();",
        "  messages.mock.restore();",
        "  try {",
        "    await broker.close().catch(() => undefined);",
        "    // Independent observed-exit cleanup also joins the deliberately failing baseline.",
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
        onReady: (child) => {
          if (process.platform === "win32") {
            // Windows uses verified native Job cleanup, not the POSIX tree option.
            // Refuse the optional direct-spawn fallback: a Job has no command PID yet.
            expect(getManagedChildCommandPid(child)).toBeUndefined();
          }
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toBe("native-exit-retry-verified");
    binding.assertPath();
  },
);
