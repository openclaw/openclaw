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
const ownerPath = "scripts/lib/vitest-worker-run.mts";
let ownerInputs: string[] | undefined;

function fixture() {
  const root = tempDirs.make("vitest-worker-slots-");
  ownerInputs ??= collectRuntimeImportClosure(repoRoot, [ownerPath], {
    includeDynamicImports: true,
  });
  for (const input of new Set([...ownerInputs, "package.json", "tsconfig.json"])) {
    const destination = path.join(root, input);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, input), destination);
  }
  fs.symlinkSync(
    fs.realpathSync(path.join(repoRoot, "node_modules")),
    path.join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const occupied = path.join(root, ".artifacts/vitest-workers/run-cache-0");
  fs.mkdirSync(occupied, { recursive: true });
  fs.writeFileSync(path.join(occupied, "retained"), "uncertain borrower still owns this directory");
  const probe = path.join(root, "slot-probe.mjs");
  fs.writeFileSync(
    probe,
    `import fs from 'node:fs';
import { createVitestWorkerRun } from ${JSON.stringify(pathToFileURL(path.join(root, ownerPath)).href)};
const owners = [];
let observed;
try {
  const first = createVitestWorkerRun();
  owners.push(first);
  const firstMode = fs.statSync(first.descriptor.directory).mode & 0o777;
  const second = createVitestWorkerRun();
  owners.push(second);
  await first.dispose();
  const firstReleased = !fs.existsSync(first.descriptor.directory);
  const secondAlive = fs.existsSync(second.descriptor.directory);
  const third = createVitestWorkerRun();
  owners.push(third);
  observed = {
    first: first.descriptor.directory,
    firstMode,
    second: second.descriptor.directory,
    third: third.descriptor.directory,
    firstReleased,
    secondAlive,
  };
} finally {
  const completions = await Promise.allSettled(owners.map(owner => owner.dispose()));
  const failures = completions.filter(result => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Worker owners did not dispose');
}
console.log(JSON.stringify(observed));
`,
  );
  const preload = path.join(root, "preload.mjs");
  fs.writeFileSync(preload, "export {};\n");
  return { root, occupied, probe, preload };
}

it.each([
  { label: "local", ci: "", cache: "", preload: false, reusesReleasedSlot: true },
  { label: "CI", ci: "1", cache: "", preload: false, reusesReleasedSlot: false },
  { label: "cached CI", ci: "1", cache: "1", preload: false, reusesReleasedSlot: true },
  { label: "custom loader", ci: "1", cache: "1", preload: true, reusesReleasedSlot: false },
])(
  "preserves occupied generations and applies $label reservation lifetime",
  async ({ ci, cache, preload, reusesReleasedSlot }) => {
    const f = fixture();
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
      first: string;
      firstMode: number;
      second: string;
      third: string;
      firstReleased: boolean;
      secondAlive: boolean;
    };
    expect(observed.firstReleased).toBe(true);
    if (process.platform !== "win32") {
      expect(observed.firstMode).toBe(0o700 & ~process.umask());
    }
    expect(observed.secondAlive).toBe(true);
    expect(observed.first).not.toBe(observed.second);
    expect(observed.third).not.toBe(observed.second);
    if (reusesReleasedSlot) {
      expect(observed.third).toBe(observed.first);
    } else {
      expect(observed.third).not.toBe(observed.first);
    }
    for (const directory of new Set([observed.first, observed.second, observed.third])) {
      expect(directory).not.toBe(f.occupied);
      expect(fs.existsSync(directory)).toBe(false);
    }
    expect(fs.readFileSync(path.join(f.occupied, "retained"), "utf8")).toBe(
      "uncertain borrower still owns this directory",
    );
    expect(fs.readdirSync(path.dirname(f.occupied))).toEqual([path.basename(f.occupied)]);
  },
);
