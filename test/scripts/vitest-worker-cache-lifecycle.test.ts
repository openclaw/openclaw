import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { collectRuntimeImportClosure } from "../../scripts/lib/runtime-import-closure.mts";
import { runNodeScript } from "../helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "../vitest/vitest.timeouts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

it("retains verified artifacts after the runner's module loader stops", async () => {
  const root = tempDirs.make("vitest-worker-loader-shutdown-");
  const ownerPath = "scripts/lib/vitest-worker-run.mts";
  const closure = collectRuntimeImportClosure(repoRoot, [ownerPath], {
    includeDynamicImports: true,
  });
  for (const file of new Set([...closure, "package.json", "tsconfig.json"])) {
    const destination = path.join(root, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, file), destination);
  }
  fs.symlinkSync(
    fs.realpathSync(path.join(repoRoot, "node_modules")),
    path.join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const artifactsUrl = pathToFileURL(
    path.join(root, "scripts/lib/vitest-worker-artifacts.mts"),
  ).href;
  const cacheUrl = pathToFileURL(path.join(root, "scripts/lib/vitest-worker-cache.mts")).href;
  const input = path.join(root, "fixture-input.ts");
  const output = 'export const value = "compiled fixture";\n';
  fs.writeFileSync(input, "export {};\n");
  // The real owner still launches and joins a native compiler child and verifies its files.
  fs.writeFileSync(
    path.join(root, "scripts/lib/vitest-worker-compiler.mts"),
    `import fs from 'node:fs';
import path from 'node:path';
import { hashVitestWorkerArtifact as hash } from ${JSON.stringify(artifactsUrl)};
const directory = process.argv[2];
fs.mkdirSync(path.join(directory, 'dist'));
const code = ${JSON.stringify(output)};
const info = '{}\\n';
fs.writeFileSync(path.join(directory, 'dist/probe.js'), code);
fs.writeFileSync(path.join(directory, 'dist/build-info.json'), info);
const inputs = { [${JSON.stringify(input)}]: hash(fs.readFileSync(${JSON.stringify(input)})) };
const outputs = { 'probe.js': hash(code), 'build-info.json': hash(info) };
fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
  identity: hash(JSON.stringify([inputs, outputs])), inputs, outputs, durationMs: 1,
  cacheSignature: hash('fixture compiler generation'),
}));
`,
  );
  const borrower = path.join(root, "borrower.mjs");
  fs.writeFileSync(
    borrower,
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
  const probe = path.join(root, "probe.mjs");
  fs.writeFileSync(
    probe,
    `import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
const { createVitestWorkerRun } = await import(${JSON.stringify(pathToFileURL(path.join(root, ownerPath)).href)});
const owner = createVitestWorkerRun();
try {
  const child = spawn(process.execPath, [${JSON.stringify(borrower)}, owner.descriptor.directory], {
    cwd: ${JSON.stringify(root)}, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Error('borrower failed: ' + code + '/' + signal));
    });
  });
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
