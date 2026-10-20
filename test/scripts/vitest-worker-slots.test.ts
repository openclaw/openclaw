import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { runNodeScript } from "../helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "../vitest/vitest.timeouts.js";
import { copyWorkerRunFixture, writeFixture } from "./vitest-worker-artifacts.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function fixture(lateMetadata = false) {
  const root = tempDirs.make("vitest-worker-slots-");
  const ownerUrl = copyWorkerRunFixture(root);
  const occupied = path.join(root, ".artifacts/vitest-workers/run-cache-0");
  fs.mkdirSync(occupied, { recursive: true });
  fs.writeFileSync(path.join(occupied, "retained"), "owned");
  const probe = writeFixture(
    root,
    "slot-probe.mjs",
    `import fs from 'node:fs';
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
let observed;
try {
  const first = reserve();
  metadataTarget = first.descriptor.directory;
  const firstMode = fs.statSync(first.descriptor.directory).mode & 0o777;
  const second = reserve();
  await first.dispose();
  const firstReleased = !fs.existsSync(first.descriptor.directory);
  const secondAlive = fs.existsSync(second.descriptor.directory);
  const third = reserve();
  observed = {
    directories: [first, second, third].map(owner => owner.descriptor.directory),
    firstMode,
    firstReleased,
    secondAlive,
    metadataInjected,
  };
} finally {
  fs.rmdir = originalRmdir;
  const completions = await Promise.allSettled(owners.map(owner => owner.dispose()));
  const failures = completions.filter(result => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Worker owners did not dispose');
}
console.log(JSON.stringify(observed));
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
    const f = fixture(label === "late metadata");
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
    const observed = JSON.parse(result.stdout) as {
      directories: [string, string, string];
      firstMode: number;
      firstReleased: boolean;
      secondAlive: boolean;
      metadataInjected: boolean;
    };
    expect(observed).toMatchObject({
      firstReleased: true,
      secondAlive: true,
      metadataInjected: label === "late metadata",
    });
    if (process.platform !== "win32") {
      expect(observed.firstMode).toBe(0o700 & ~process.umask());
    }
    const [first, second, third] = observed.directories;
    expect([first, third]).not.toContain(second);
    expect(third === first).toBe(reusesReleasedSlot);
    for (const directory of new Set(observed.directories)) {
      expect(directory).not.toBe(f.occupied);
      expect(fs.existsSync(directory)).toBe(false);
    }
    expect(fs.readFileSync(path.join(f.occupied, "retained"), "utf8")).toBe("owned");
    expect(fs.readdirSync(path.dirname(f.occupied))).toEqual([path.basename(f.occupied)]);
  },
);
