import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { runNodeScript } from "../helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "../vitest/vitest.timeouts.js";
import { copyWorkerRunFixture, writeFixture } from "./vitest-worker-artifacts.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("retains verified artifacts after the runner's module loader stops", async () => {
  const root = tempDirs.make("vitest-worker-loader-shutdown-");
  const ownerUrl = copyWorkerRunFixture(root);
  const artifactsUrl = pathToFileURL(
    path.join(root, "scripts/lib/vitest-worker-artifacts.mts"),
  ).href;
  const cacheUrl = pathToFileURL(path.join(root, "scripts/lib/vitest-worker-cache.mts")).href;
  const input = writeFixture(root, "fixture-input.ts", "export {};\n");
  const output = 'export const value = "compiled fixture";\n';
  // The real owner still launches and joins a native compiler child and verifies its files.
  writeFixture(
    root,
    "scripts/lib/vitest-worker-compiler.mts",
    `import fs from 'node:fs';
import path from 'node:path';
import { hashVitestWorkerArtifact as hash } from ${JSON.stringify(artifactsUrl)};
const directory = process.argv[2];
fs.mkdirSync(path.join(directory, 'dist'));
const files = { 'probe.js': ${JSON.stringify(output)}, 'build-info.json': '{}\\n' };
for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(directory, 'dist', name), bytes);
const inputs = { [${JSON.stringify(input)}]: hash(fs.readFileSync(${JSON.stringify(input)})) };
const outputs = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, hash(bytes)]));
fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
  identity: hash(JSON.stringify([inputs, outputs])), inputs, outputs, durationMs: 1,
  cacheSignature: hash('fixture compiler generation'),
}));
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
  console.log('joined cleanup retained verified artifacts');
} finally {
  try { await owner.dispose(); }
  finally { hooks.deregister(); }
}
`,
  );
  const result = await runNodeScript(
    probe,
    {
      ...process.env,
      CI: "",
      GITHUB_ACTIONS: "",
      NODE_OPTIONS: "",
      NODE_PATH: "",
      NAPI_RS_NATIVE_LIBRARY_PATH: "",
      NAPI_RS_WASI_FLAVOR: "",
      NAPI_RS_FORCE_WASI: "",
    },
    DEFAULT_VITEST_TEST_TIMEOUT_MS,
    { cwd: root, requireProcessTreeExit: process.platform !== "win32" },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(result.stdout).toContain("joined cleanup retained verified artifacts");
});
