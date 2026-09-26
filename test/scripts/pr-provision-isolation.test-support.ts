import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertManagedHandoffTestConsumer,
  createManagedHandoffTestBinding,
} from "../helpers/managed-handoff-isolation.js";

const shellQuote = (value: string) => `'${value.replace(/'/gu, `'\\''`)}'`;

/** Own the binding until the supervisor and all its descendants have joined. */
export function createProvisionIsolationFixture(directory: string, canonical: string) {
  const root = realpathSync(directory);
  const repository = realpathSync(canonical);
  const identity = statSync(repository, { bigint: true });
  const storeRoot = join(root, "handoff");
  const bin = join(root, "handoff-bin");
  mkdirSync(storeRoot, { mode: 0o700 });
  mkdirSync(bin);
  const binding = createManagedHandoffTestBinding(storeRoot);
  const launches = join(root, "provisioner-launches.txt");
  const observations = join(root, "provisioner-stores.jsonl");
  const preload = join(root, "provisioner-store-preload.mjs");
  const stateDatabase = join(repository, ".local", "pr-state", "state", "openclaw.sqlite");
  writeFileSync(launches, "");
  writeFileSync(observations, "");
  // Explicit argv survives env replacement and other tests replacing NODE_OPTIONS.
  // Never patch the wrapper, its trust anchor, or the sealed-runtime registry.
  const nodeArgs = [binding.nodeOption, `--import=${pathToFileURL(preload).href}`];
  writeFileSync(
    join(bin, "node"),
    `#!/bin/sh
set -eu
for arg in "$@"; do
  case "$arg" in
    */scripts/pr-lib/worktree-provision.mts)
      printf '%s\\n' "$$" >> ${shellQuote(launches)}
      break ;;
  esac
done
exec ${shellQuote(realpathSync(process.execPath))} ${nodeArgs.map(shellQuote).join(" ")} "$@"
`,
  );
  chmodSync(join(bin, "node"), 0o755);
  writeFileSync(
    preload,
    `import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createManagedHandoffTestBinding } from ${JSON.stringify(new URL("../helpers/managed-handoff-isolation.ts", import.meta.url).href)};
const binding = createManagedHandoffTestBinding(${JSON.stringify(storeRoot)});
assert(fs.readdirSync(binding.directory).some(name => {
  if (!name.startsWith('preflight-' + process.pid + '-0-')) return false;
  const witness = JSON.parse(fs.readFileSync(path.join(binding.directory, name), 'utf8'));
  return witness.phase === 'preload' && witness.databasePath === binding.databasePath;
}), 'Missing private provisioner handoff preload');
const repository = ${JSON.stringify(repository)};
const stateDatabase = ${JSON.stringify(stateDatabase)};
const observations = ${JSON.stringify(observations)};
const entry = process.argv[1];
const provisioner = entry?.endsWith('/scripts/pr-lib/worktree-provision.mts');
const sourceRoot = provisioner ? path.resolve(path.dirname(fs.realpathSync(entry)), '../..') : null;
let phase = 'preflight';
function observe(kind, databasePath) {
  fs.appendFileSync(observations, JSON.stringify({kind, phase, pid: process.pid, sourceRoot, databasePath}) + '\\n');
}
function assertPrivateState(location) {
  // Check spelling before even stat'ing a path: negatives never inspect live stores.
  assert(location === stateDatabase, 'Unexpected provisioning SQLite store: ' + location);
  const stat = fs.lstatSync(repository, {bigint: true});
  assert.equal(fs.realpathSync(repository), repository, 'Canonical repository alias');
  assert.equal(String(stat.dev), ${JSON.stringify(String(identity.dev))});
  assert.equal(String(stat.ino), ${JSON.stringify(String(identity.ino))}, 'Canonical repository identity changed');
  for (let parent = path.dirname(location); parent !== repository; parent = path.dirname(parent)) {
    const entry = fs.lstatSync(parent);
    assert(entry.isDirectory() && !entry.isSymbolicLink(), 'Canonical state directory alias');
    assert.equal(fs.realpathSync(parent), parent, 'Canonical state namespace alias');
  }
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const file = location + suffix;
    let entry;
    try { entry = fs.lstatSync(file); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    assert(entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1, 'Canonical state file alias');
    assert.equal(fs.realpathSync(file), file);
  }
}
// Observe the real SQLite constructor; all SQL, leases and closes remain native.
const sqlite = createRequire(import.meta.url)('node:sqlite');
const seen = new Set();
sqlite.DatabaseSync = new Proxy(sqlite.DatabaseSync, {
  construct(target, args, newTarget) {
    const supplied = args[0];
    const location = typeof supplied === 'string' && supplied.startsWith('file:')
      ? fileURLToPath(new URL(supplied)) : supplied;
    if (location !== ':memory:') {
      if (location === binding.databasePath) binding.assertPath(location);
      else {
        try { assertPrivateState(location); } catch (error) {
          console.error('[private-provision-store]', error.message);
          throw error;
        }
      }
    }
    const database = Reflect.construct(target, args, newTarget);
    if (location !== ':memory:' && !seen.has(phase + location)) {
      seen.add(phase + location);
      observe('sqlite-open', location);
    }
    return database;
  },
});
syncBuiltinESMExports();
if (provisioner) {
  assert.equal(fs.realpathSync(process.argv[2]), repository);
  await import(pathToFileURL(path.join(sourceRoot, 'scripts/tsx.mjs')).href);
  const { resolveManagedUpdateLeaseDatabasePath, createManagedHandoffLeaseStore } = await import(
    pathToFileURL(path.join(sourceRoot, 'src/infra/update-managed-service-handoff-lease.ts')).href);
  assert.equal(resolveManagedUpdateLeaseDatabasePath(), binding.databasePath, 'Missing private provisioner handoff binding');
  const store = createManagedHandoffLeaseStore();
  const installation = path.join(binding.directory, 'installation');
  const acquired = store.acquire(installation, 'provisioner-test', {kind: 'update'});
  assert.equal(acquired.kind, 'acquired');
  try {
    assert.equal(store.read(installation).kind, 'current');
  } finally {
    assert.equal(store.release(acquired.lease), true);
  }
  assert.equal(store.read(installation).kind, 'absent');
  const { withConfigWriteLock } = await import(pathToFileURL(path.join(sourceRoot, 'src/config/write-lock.ts')).href);
  const config = path.join(binding.directory, 'custody.json');
  await withConfigWriteLock(config, async () => fs.writeFileSync(config, '{}\\n'));
  assert.equal(fs.readFileSync(config, 'utf8'), '{}\\n');
  assert.equal(fs.existsSync(config + '.lock'), false);
  fs.unlinkSync(config);
  observe('store-and-config-custody-verified', binding.databasePath);
}
phase = 'workload';
if (provisioner) {
  try {
    await import(pathToFileURL(entry).href);
  } finally {
    const {closeOpenClawStateDatabaseAsync} = await import(
      pathToFileURL(path.join(sourceRoot, 'src/state/openclaw-state-db.ts')).href);
    await closeOpenClawStateDatabaseAsync();
  }
}
`,
  );
  return {
    binding,
    nodeArgs,
    bin,
    preload,
    launches,
    observations,
    stateDatabase,
    path: (inheritedPath: string) => [bin, inheritedPath].join(delimiter),
    assertProvisioner() {
      const pids = readFileSync(launches, "utf8").trim().split("\n").filter(Boolean).map(Number);
      assert(pids.length > 0, "No provisioner launched through the bound Node entrypoint");
      const rows = readFileSync(observations, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      for (const pid of pids) {
        const probe = rows.find(
          (row) => row.pid === pid && row.kind === "store-and-config-custody-verified",
        );
        assert(probe, `Provisioner ${pid} did not exercise the private handoff store`);
        assertManagedHandoffTestConsumer(binding, pid, join(probe.sourceRoot, "src"));
        assert(
          rows.some(
            (row) =>
              row.pid === pid &&
              row.phase === "workload" &&
              row.kind === "sqlite-open" &&
              row.databasePath === stateDatabase,
          ),
          "No actual canonical-state consumer witness",
        );
      }
      return { pids, rows };
    },
  };
}
