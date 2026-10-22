import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { runNodeScript } from "../helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "../vitest/vitest.timeouts.js";
import { copyWorkerRunFixture, writeFixture } from "./vitest-worker-artifacts.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
let directories;
try {
  const first = reserve();
  metadataTarget = first.descriptor.directory;
  if (process.platform !== 'win32') assert.equal(fs.statSync(metadataTarget).mode & 0o777, ${0o700 & ~process.umask()});
  const second = reserve();
  await first.dispose();
  assert.equal(fs.existsSync(first.descriptor.directory), false);
  assert.equal(fs.existsSync(second.descriptor.directory), true);
  const third = reserve();
  directories = [first, second, third].map(owner => owner.descriptor.directory);
  assert.notEqual(directories[0], directories[1]);
  assert.notEqual(directories[2], directories[1]);
  assert.equal(directories[2] === directories[0], ${reusesReleasedSlot});
} finally {
  fs.rmdir = originalRmdir;
  const completions = await Promise.allSettled(owners.map(owner => owner.dispose()));
  const failures = completions.filter(result => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Worker owners did not dispose');
}
assert.equal(metadataInjected, ${lateMetadata});
console.log(JSON.stringify(directories));
`,
  );
  const preload = writeFixture(root, "preload.mjs", "export {};\n");
  return { root, occupied, probe, preload };
}

it.each([
  { label: "CI", ci: "1", cache: "", preload: false, reusesReleasedSlot: false },
  { label: "cached CI", ci: "1", cache: "1", preload: false, reusesReleasedSlot: true },
  { label: "custom loader", ci: "1", cache: "1", preload: true, reusesReleasedSlot: false },
  { label: "late metadata", ci: "", cache: "", preload: false, reusesReleasedSlot: true },
])(
  "preserves occupied generations and applies $label reservation lifetime",
  async ({ label, ci, cache, preload, reusesReleasedSlot }) => {
    const f = fixture(label === "late metadata", reusesReleasedSlot);
    const result = await runNodeScript(
      f.probe,
      {
        ...process.env,
        CI: ci,
        GITHUB_ACTIONS: "",
        OPENCLAW_VITEST_WORKER_CACHE: cache,
        NODE_OPTIONS: preload ? `"--im\\port" "${pathToFileURL(f.preload).href}"` : "",
        NODE_PATH: "",
      },
      DEFAULT_VITEST_TEST_TIMEOUT_MS,
      { cwd: f.root, requireProcessTreeExit: process.platform !== "win32" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const directories = JSON.parse(result.stdout) as [string, string, string];
    for (const directory of new Set(directories)) {
      expect(directory).not.toBe(f.occupied);
      expect(fs.existsSync(directory)).toBe(false);
    }
    expect(fs.readFileSync(path.join(f.occupied, "retained"), "utf8")).toBe("owned");
    expect(fs.readdirSync(path.dirname(f.occupied))).toEqual([path.basename(f.occupied)]);
  },
);
