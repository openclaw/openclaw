import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { runNodeScript } from "../helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "../vitest/vitest.timeouts.js";
import { copyWorkerRunFixture, writeFixture } from "./vitest-worker-artifacts.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fixtureUrl = (root: string, name: string) =>
  pathToFileURL(path.join(root, `scripts/lib/${name}.mts`)).href;
const manifestFixture = new URL("./fixtures/vitest-worker-compiler.mjs", import.meta.url).href;

async function runProbe(root: string, probe: string, env: NodeJS.ProcessEnv) {
  const result = await runNodeScript(
    probe,
    { ...process.env, CI: "", GITHUB_ACTIONS: "", NODE_OPTIONS: "", NODE_PATH: "", ...env },
    DEFAULT_VITEST_TEST_TIMEOUT_MS,
    { cwd: root, requireProcessTreeExit: process.platform !== "win32" },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr + result.stdout).toBe(0);
}

it("retains verified artifacts after the runner's module loader stops", async () => {
  const root = tempDirs.make("vitest-worker-loader-shutdown-");
  const ownerUrl = copyWorkerRunFixture(root);
  const artifactsUrl = fixtureUrl(root, "vitest-worker-artifacts");
  const cacheUrl = fixtureUrl(root, "vitest-worker-cache");
  const input = writeFixture(root, "fixture-input.ts", "export {};\n");
  const output = 'export const value = "compiled fixture";\n';
  // The real owner still launches and joins a native compiler child and verifies its files.
  writeFixture(
    root,
    "scripts/lib/vitest-worker-compiler.mts",
    `import { writeWorkerFixtureManifest } from ${JSON.stringify(manifestFixture)};
import { hashVitestWorkerArtifact as hash } from ${JSON.stringify(artifactsUrl)};
import fs from 'node:fs';
import path from 'node:path';
const directory = process.argv[2];
const manifest = writeWorkerFixtureManifest(directory, { [${JSON.stringify(input)}]: fs.readFileSync(${JSON.stringify(input)}) },
  { 'probe.js': ${JSON.stringify(output)}, 'build-info.json': '{}\\n' });
manifest.cacheSignature = hash('fixture compiler generation');
fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
`,
  );
  const borrower = writeFixture(
    root,
    "borrower.mjs",
    `import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { requestVitestWorkerArtifacts } from ${JSON.stringify(artifactsUrl)};
try {
  await requestVitestWorkerArtifacts();
  const { value } = await import(pathToFileURL(path.join(process.argv[2], 'dist/probe.js')).href);
  assert.equal(value, 'compiled fixture');
} finally {
  process.disconnect();
}
`,
  );
  const probe = writeFixture(
    root,
    "probe.mjs",
    `import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
let stopped = false;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (stopped && url === ${JSON.stringify(cacheUrl)}) {
      throw new Error('fixture module loader has stopped');
    }
    return nextLoad(url, context);
  },
});
const { createVitestWorkerRun } = await import(${JSON.stringify(ownerUrl)});
const owner = createVitestWorkerRun();
try {
  const child = spawn(process.execPath, [${JSON.stringify(borrower)}, owner.descriptor.directory], {
    cwd: ${JSON.stringify(root)}, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const completion = once(child, 'close').then(result => assert.deepEqual(result, [0, null]));
  await owner.borrow(child, completion);
  stopped = true;
  await owner.dispose();
  const cached = path.join(${JSON.stringify(root)}, '.artifacts/vitest-worker-cache', path.basename(owner.descriptor.directory));
  assert.equal(fs.existsSync(owner.descriptor.directory), false);
  assert.equal(fs.readFileSync(path.join(cached, 'outputs/dist/probe.js'), 'utf8'), ${JSON.stringify(output)});
  assert.equal(fs.existsSync(path.join(cached, 'stamp.json')), true);
} finally {
  try { await owner.dispose(); }
  finally { hooks.deregister(); }
}
`,
  );
  await runProbe(root, probe, {
    NAPI_RS_NATIVE_LIBRARY_PATH: "",
    NAPI_RS_WASI_FLAVOR: "",
    NAPI_RS_FORCE_WASI: "",
  });
});

it("defaults to full and rejects borrowers broader than their connected parent", async () => {
  const root = tempDirs.make("vitest-worker-presets-");
  const ownerUrl = copyWorkerRunFixture(root);
  const borrower = writeFixture(
    root,
    "preset-borrower.mjs",
    `import assert from 'node:assert/strict';
import { createVitestWorkerRun } from ${JSON.stringify(ownerUrl)};
const [full, runtime] = JSON.parse(process.argv[2]);
try {
  for (const [parent, requested, expected] of [
    [{directory: full.directory}, 'runtime', 'full'],
    [full, 'runtime', 'full'],
    [runtime, undefined, 'runtime'],
    [runtime, 'runtime', 'runtime'],
  ]) {
    const owner = createVitestWorkerRun(process.env, parent, requested);
    try {
      assert.equal(owner.descriptor.preset, expected);
      assert.equal(owner.descriptor.directory, parent.directory);
    } finally {
      await owner.dispose();
    }
  }
  assert.throws(() => createVitestWorkerRun(process.env, runtime, 'full'),
    /Runtime compiled subprocess owner cannot serve a full preset borrower/);
} finally {
  process.disconnect();
}
`,
  );
  const probe = writeFixture(
    root,
    "preset-owner.mjs",
    `import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createVitestWorkerRun } from ${JSON.stringify(ownerUrl)};
const full = createVitestWorkerRun();
const explicit = createVitestWorkerRun(process.env, undefined, 'full');
const runtime = createVitestWorkerRun(process.env, undefined, 'runtime');
const owners = [full, explicit, runtime];
try {
  assert.deepEqual(owners.map(owner => owner.descriptor.preset), ['full', 'full', 'runtime']);
  const child = spawn(process.execPath, [${JSON.stringify(borrower)}, JSON.stringify([full.descriptor, runtime.descriptor])], {
    cwd: ${JSON.stringify(root)}, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  await full.borrow(child, once(child, 'close').then(result => assert.deepEqual(result, [0, null])));
} finally {
  await Promise.all(owners.map(owner => owner.dispose()));
}
assert(owners.every(owner => !fs.existsSync(owner.descriptor.directory)));
`,
  );
  await runProbe(root, probe, {});
});

function fixture(lateMetadata: boolean, reusesReleasedSlot: boolean) {
  const root = tempDirs.make("vitest-worker-slots-");
  const ownerUrl = copyWorkerRunFixture(root);
  const occupied = path.join(root, ".artifacts/vitest-workers/run-cache-0");
  fs.mkdirSync(occupied, { recursive: true });
  fs.writeFileSync(path.join(occupied, "retained"), "owned");
  const probe = writeFixture(
    root,
    "slot-probe.mjs",
    `import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const originalRmdir = fs.rmdir;
let metadataTarget;
let metadataInjected = false;
if (${JSON.stringify(lateMetadata)}) {
  fs.rmdir = (target, ...args) => {
    if (metadataTarget === String(target) && !metadataInjected && fs.readdirSync(target).length === 0) {
      fs.writeFileSync(path.join(metadataTarget, '.DS_Store'), 'late metadata');
      metadataInjected = true;
    }
    return originalRmdir(target, ...args);
  };
}
const { createVitestWorkerRun } = await import(${JSON.stringify(ownerUrl)});
const owners = [];
const reserve = () => {
  const owner = createVitestWorkerRun();
  owners.push(owner);
  return owner;
};
try {
  const first = reserve();
  metadataTarget = first.descriptor.directory;
  if (process.platform !== 'win32') assert.equal(fs.statSync(metadataTarget).mode & 0o777, ${0o700 & ~process.umask()});
  const second = reserve();
  if (${reusesReleasedSlot}) {
    const runtime = createVitestWorkerRun(process.env, undefined, 'runtime');
    owners.push(runtime);
    assert.equal(path.basename(runtime.descriptor.directory), 'run-cache-runtime-0');
    assert.equal(path.basename(first.descriptor.directory), 'run-cache-1');
    const nextRuntime = createVitestWorkerRun(process.env, undefined, 'runtime');
    owners.push(nextRuntime);
    assert.equal(path.basename(nextRuntime.descriptor.directory), 'run-cache-runtime-1');
    await runtime.dispose();
    const reusedRuntime = createVitestWorkerRun(process.env, undefined, 'runtime');
    owners.push(reusedRuntime);
    assert.equal(reusedRuntime.descriptor.directory, runtime.descriptor.directory);
    assert(fs.existsSync(nextRuntime.descriptor.directory));
    assert(fs.existsSync(first.descriptor.directory));
  }
  await first.dispose();
  assert.equal(fs.existsSync(first.descriptor.directory), false);
  assert.equal(fs.existsSync(second.descriptor.directory), true);
  const third = reserve();
  const directories = [first, second, third].map(owner => owner.descriptor.directory);
  assert.notEqual(directories[2], directories[1]);
  assert.equal(directories[2] === directories[0], ${reusesReleasedSlot});
} finally {
  fs.rmdir = originalRmdir;
  const completions = await Promise.allSettled(owners.map(owner => owner.dispose()));
  const failures = completions.filter(result => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Worker owners did not dispose');
}
assert.equal(metadataInjected, ${lateMetadata});
`,
  );
  return { root, occupied, probe };
}

it.each([
  { label: "CI", ci: "1", cache: "", reusesReleasedSlot: false },
  { label: "cached CI", ci: "1", cache: "1", reusesReleasedSlot: true },
  { label: "late metadata", ci: "", cache: "", reusesReleasedSlot: true },
])(
  "preserves occupied generations and applies $label reservation lifetime",
  async ({ label, ci, cache, reusesReleasedSlot }) => {
    const f = fixture(label === "late metadata", reusesReleasedSlot);
    await runProbe(f.root, f.probe, {
      CI: ci,
      OPENCLAW_VITEST_WORKER_CACHE: cache,
    });
    expect(fs.readFileSync(path.join(f.occupied, "retained"), "utf8")).toBe("owned");
    expect(fs.readdirSync(path.dirname(f.occupied))).toEqual([path.basename(f.occupied)]);
  },
);
