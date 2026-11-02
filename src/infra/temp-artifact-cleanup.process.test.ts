import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { escapeRegExp } from "../shared/regexp.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { isContainerEnvironment } from "./container-environment.js";
import * as processCensus from "./openclaw-process-census.js";
import { claimUpdateArtifact, maintainRetainedUpdateRuntimes } from "./temp-artifact-cleanup.js";

// Real census, real children. Each child is owned here and killed before its directory goes.
const dirs = useAutoCleanupTempDirTracker(afterEach);
const children = new Set<ChildProcess>();
afterEach(async () => {
  await Promise.all([...children].map(stop));
  children.clear();
  vi.restoreAllMocks();
});

const translated = process.arch === "x64" && os.cpus()[0]?.model.includes("Apple");
// Elsewhere, and in containers, a missing holder is not proof, so only age reclaims.
const native =
  (process.platform === "darwin" || process.platform === "linux") &&
  !translated &&
  !isContainerEnvironment();
const DAY_MS = 24 * 60 * 60 * 1000;

let base: string;
let checkout: string;

beforeEach(() => {
  base = fs.realpathSync(dirs.make("update-artifact-sweep-"));
  checkout = path.join(base, "checkout");
  fs.mkdirSync(checkout);
  fs.writeFileSync(path.join(checkout, "package.json"), '{"name":"openclaw"}');
  // A process running this entry is an OpenClaw process, but does not use any prior-run artifact.
  fs.writeFileSync(
    path.join(checkout, "openclaw.mjs"),
    'console.log("ready"); setInterval(() => {}, 1e9);\n',
  );
  // The sweep scans the temporary directory; keep it away from the host's real one.
  vi.spyOn(os, "tmpdir").mockReturnValue(base);
});

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

/** Resolves once the child has run its own code, so its argv, cwd and mappings are in place. */
async function start(args: string[], options: { cwd?: string; file?: string } = {}) {
  const child = spawn(process.execPath, args, {
    cwd: options.cwd ?? base,
    env: {
      PATH: process.env.PATH,
      HOME: base,
      TMPDIR: base,
      ...(options.file ? { FIXTURE_FILE: options.file } : {}),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.add(child);
  await once(child.stdout, "data");
  return child;
}

const startUnrelatedOpenClaw = () => start([path.join(checkout, "openclaw.mjs")]);
const idleScript = 'console.log("ready"); setInterval(() => {}, 1e9);';

function age(directory: string, ms: number) {
  const when = new Date(Date.now() - ms);
  fs.utimesSync(directory, when, when);
}

/** A complete prior-run projection recognized by its package marker, as older updaters left it. */
function projection(name: string, ageMs = 2 * DAY_MS): string {
  const directory = path.join(base, `openclaw-update-runtime-${name}`);
  const root = path.join(
    directory,
    "tree",
    Buffer.from(path.parse(checkout).root).toString("hex"),
    path.relative(path.parse(checkout).root, checkout),
  );
  fs.mkdirSync(root, { recursive: true });
  fs.copyFileSync(path.join(checkout, "package.json"), path.join(root, "package.json"));
  age(directory, ageMs);
  return directory;
}

const sweep = (options: { budgetMs?: number; onWarning?: (warning: string) => void } = {}) =>
  maintainRetainedUpdateRuntimes({
    packageRoots: [checkout],
    repair: true,
    assertCurrent() {},
    // Module loading under the test transform is not what the sweep's budget bounds.
    budgetMs: 120_000,
    ...options,
  });

/**
 * One unreadable host process fails a real census as a whole, for instance one that is mid-exec.
 * The next sweep is the product's own answer to that, so each attempt here is a fresh sweep.
 */
async function sweepFor(
  expected: readonly string[],
  options: Parameters<typeof sweep>[0] = {},
): Promise<string[]> {
  const output: string[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    output.push(...(await sweep(options)));
    if (expected.every((text) => output.some((line) => line.includes(text)))) {
      break;
    }
  }
  return output;
}

// Nothing records which run made an artifact, so a day's age is what shows its run ended.
function preflight(name: string, ageMs = 2 * DAY_MS): string {
  const directory = path.join(checkout, ".artifacts", `.openclaw-update-preflight-${name}`);
  fs.mkdirSync(path.join(directory, "worktree"), { recursive: true });
  fs.writeFileSync(path.join(directory, "worktree", ".git"), "gitdir: elsewhere\n");
  age(directory, ageMs);
  return directory;
}

function admission(name: string, ageMs = 2 * DAY_MS): string {
  const directory = path.join(base, `openclaw-git-admission-${name}`);
  fs.mkdirSync(path.join(directory, "repository.git"), { recursive: true });
  age(directory, ageMs);
  return directory;
}

it.runIf(native)(
  "reclaims a prior-run runtime while an unrelated OpenClaw process runs",
  async () => {
    const directory = projection("Unused");
    const unrelated = await startUnrelatedOpenClaw();
    const removed = `Removed abandoned updater runtime: ${directory}`;
    expect(await sweepFor([removed])).toContain(removed);
    expect(fs.existsSync(directory)).toBe(false);
    expect(unrelated.exitCode).toBeNull();
  },
);

it.runIf(native)("keeps a runtime while a process runs from it, then reclaims it", async () => {
  const directory = projection("Script");
  const script = path.join(directory, "worker.mjs");
  fs.writeFileSync(script, idleScript);
  age(directory, 2 * DAY_MS);
  const holder = await start([script]);
  const held = `PIDs: ${holder.pid}`;
  expect(await sweepFor([held])).toContainEqual(expect.stringContaining(held));
  expect(fs.existsSync(script)).toBe(true);
  await stop(holder);
  const removed = `Removed abandoned updater runtime: ${directory}`;
  expect(await sweepFor([removed])).toContain(removed);
  expect(fs.existsSync(directory)).toBe(false);
});

it.runIf(native)("keeps a runtime while a process's working directory is inside it", async () => {
  const directory = projection("Cwd001");
  const inner = path.join(directory, "tree");
  const holder = await start(["-e", idleScript], { cwd: inner });
  age(directory, 2 * DAY_MS);
  const held = `PIDs: ${holder.pid}`;
  expect(await sweepFor([held])).toContainEqual(expect.stringContaining(held));
  expect(fs.existsSync(inner)).toBe(true);
});

it.runIf(native)("keeps a runtime while a process only has a file mapped from it", async () => {
  // Neither argv nor cwd names the runtime: the mapping alone is the evidence, as for a Gateway.
  const directory = projection("Mapped");
  const require = createRequire(import.meta.url);
  const packageRoot = path.dirname(require.resolve("@openclaw/proc-safe/package.json"));
  const addons = fs
    .readdirSync(path.dirname(packageRoot))
    .flatMap((name) =>
      name.startsWith("proc-safe-")
        ? [path.join(path.dirname(packageRoot), name, "proc-safe-native.node")]
        : [],
    )
    .filter((file) => fs.existsSync(file));
  expect(addons.length).toBeGreaterThan(0);
  const mapped = path.join(directory, "native.node");
  fs.copyFileSync(addons[0]!, mapped);
  age(directory, 2 * DAY_MS);
  const holder = await start(
    ["-e", `process.dlopen({ exports: {} }, process.env.FIXTURE_FILE); ${idleScript}`],
    { file: mapped },
  );
  const held = `PIDs: ${holder.pid}`;
  expect(await sweepFor([held])).toContainEqual(expect.stringContaining(held));
  expect(fs.existsSync(mapped)).toBe(true);
  await stop(holder);
  const removed = `Removed abandoned updater runtime: ${directory}`;
  expect(await sweepFor([removed])).toContain(removed);
});

it.runIf(native)("does not count a mapped hard link that the running install shares", async () => {
  // A process maps the installed file, then a later projection links the same inode. Darwin
  // can now report the mapping under the runtime's path, which is not use of that runtime.
  const directory = projection("Linked");
  const require = createRequire(import.meta.url);
  const packageRoot = path.dirname(require.resolve("@openclaw/proc-safe/package.json"));
  const addon = fs
    .readdirSync(path.dirname(packageRoot))
    .flatMap((name) =>
      name.startsWith("proc-safe-")
        ? [path.join(path.dirname(packageRoot), name, "proc-safe-native.node")]
        : [],
    )
    .find((file) => fs.existsSync(file));
  assert.ok(addon);
  const installed = path.join(checkout, "native.node");
  fs.copyFileSync(addon, installed);
  const gateway = await start(
    ["-e", `process.dlopen({ exports: {} }, process.env.FIXTURE_FILE); ${idleScript}`],
    { file: installed },
  );
  const linked = path.join(directory, "native.node");
  fs.linkSync(installed, linked);
  // The lookup is what moves Darwin's name for the vnode to this path.
  fs.statSync(linked);
  age(directory, 2 * DAY_MS);
  const removed = `Removed abandoned updater runtime: ${directory}`;
  expect(await sweepFor([removed])).toContain(removed);
  expect(fs.existsSync(directory)).toBe(false);
  expect(fs.statSync(installed).nlink).toBe(1);
  expect(gateway.exitCode).toBeNull();
});

it.runIf(native)("keeps a dead run's artifact while an orphan still works inside it", async () => {
  const worktree = preflight("Orphan");
  const orphan = await start(["-e", idleScript], { cwd: path.join(worktree, "worktree") });
  const held = `PIDs: ${orphan.pid}`;
  expect(await sweepFor([held])).toContainEqual(expect.stringContaining(held));
  expect(fs.existsSync(path.join(worktree, "worktree"))).toBe(true);
  expect(orphan.exitCode).toBeNull();
});

it.runIf(native)("waits a day before reclaiming an artifact nothing uses", async () => {
  // A killed or still-running update leaves the same thing: scratch no process uses yet.
  const recent = preflight("Recnt1", 60_000);
  const recentRepository = admission("Recnt2", 60_000);
  const old = preflight("Old001");
  const oldRepository = admission("Old002");
  const removed = [
    `Removed abandoned update preflight worktree: ${old}`,
    `Removed abandoned update inspection repository: ${oldRepository}`,
  ];
  const output = await sweepFor(removed);
  expect(output).toEqual(expect.arrayContaining(removed));
  expect(fs.existsSync(old)).toBe(false);
  expect(fs.existsSync(oldRepository)).toBe(false);
  expect(fs.existsSync(recent)).toBe(true);
  expect(fs.existsSync(recentRepository)).toBe(true);
  for (const directory of [recent, recentRepository]) {
    expect(output).toContainEqual(
      expect.stringMatching(
        new RegExp(`${escapeRegExp(directory)}: .*keeping it until it is 24 hours old`, "u"),
      ),
    );
  }
});

it("preserves look-alike directories that hold something else", async () => {
  const foreign = admission("Odd001", 2 * 24 * 60 * 60 * 1000);
  fs.writeFileSync(path.join(foreign, "operator-data"), "preserve");
  const worktree = preflight("Odd002", 2 * 24 * 60 * 60 * 1000);
  fs.writeFileSync(path.join(worktree, "operator-data"), "preserve");
  const output = await sweep();
  expect(fs.readFileSync(path.join(foreign, "operator-data"), "utf8")).toBe("preserve");
  expect(fs.readFileSync(path.join(worktree, "operator-data"), "utf8")).toBe("preserve");
  expect(output).toContainEqual(
    expect.stringContaining(`${foreign}: no recognized runtime marker`),
  );
});

it.runIf(native)("the claim protects an artifact in this process until released", async () => {
  const repository = admission("Claim1");
  const release = claimUpdateArtifact(repository);
  expect(await sweep()).toContainEqual(
    expect.stringContaining(`${repository}: the creating update still owns this runtime`),
  );
  expect(fs.existsSync(repository)).toBe(true);
  release();
  const removed = `Removed abandoned update inspection repository: ${repository}`;
  expect(await sweepFor([removed])).toContain(removed);
});

it.runIf(native)(
  "a removal failure is a warning, and the next sweep finishes the job",
  async () => {
    const repository = admission("Fail01");
    const rm = vi
      .spyOn(fsPromises, "rm")
      .mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    const warnings: string[] = [];
    const failure = `${repository}: cleanup failed: denied`;
    await sweepFor([failure], { onWarning: (warning) => warnings.push(warning) });
    expect(warnings).toContainEqual(expect.stringContaining(failure));
    expect(rm).toHaveBeenCalledOnce();
    expect(fs.existsSync(`${repository}.removing`)).toBe(true);
    // The half-removed tree has lost whatever made it recognizable; its name is what remains.
    fs.rmSync(path.join(`${repository}.removing`, "repository.git"), { recursive: true });
    // No census runs for a renamed tree, so nothing here depends on the host's processes.
    expect(await sweep()).toContain(
      `Removed abandoned update inspection repository: ${repository}`,
    );
    expect(fs.existsSync(`${repository}.removing`)).toBe(false);
  },
);

it.runIf(native)("an in-use tree that refuses its rename stays whole, with a warning", async () => {
  const repository = admission("Busy01");
  const pack = path.join(repository, "repository.git", "pack");
  fs.writeFileSync(pack, "kept");
  const rename = vi
    .spyOn(fsPromises, "rename")
    .mockRejectedValueOnce(Object.assign(new Error("in use"), { code: "EPERM" }));
  const warnings: string[] = [];
  const refused = `${repository}: in use`;
  await sweepFor([refused], { onWarning: (warning) => warnings.push(warning) });
  expect(rename).toHaveBeenCalledOnce();
  expect(fs.readFileSync(pack, "utf8")).toBe("kept");
  expect(warnings).toContainEqual(expect.stringContaining(refused));
});

it.runIf(native)("does not wait for a slow removal past its budget", async () => {
  const first = admission("Slow01");
  const second = admission("Slow02");
  // Only the wait is under test: a transient census failure on a busy host would skip removal.
  vi.spyOn(processCensus, "inspectOtherOpenClawProcesses").mockReturnValue({ pids: [] });
  const actualRm = fsPromises.rm;
  let finishRemoval!: () => void;
  const hold = new Promise<void>((resolve) => {
    finishRemoval = resolve;
  });
  const removal = createDeferredCore();
  vi.spyOn(fsPromises, "rm").mockImplementation(async (...args) => {
    await hold;
    await actualRm(...args);
    removal.resolve();
  });
  // A spent budget: one artifact always gets its turn, and the rest wait for a later pass.
  const output = await sweep({ budgetMs: 0 });
  const started = fs.existsSync(`${first}.removing`) ? first : second;
  const waiting = started === first ? second : first;
  expect(output).toContain(
    `Removing abandoned update inspection repository in the background: ${started}`,
  );
  expect(output).toContainEqual(expect.stringContaining(`${waiting} waits for a later update`));
  expect(fs.existsSync(waiting)).toBe(true);
  finishRemoval();
  await removal.promise;
  expect(fs.existsSync(`${started}.removing`)).toBe(false);
});

it("on a platform without the holder check, only age reclaims, with a warning", async () => {
  // Real census path: Windows has no exact command census or mapped-file inspection here.
  const recent = admission("Win001", 0);
  const old = admission("Win002");
  const live = admission("Win003");
  const release = claimUpdateArtifact(live);
  mockProcessPlatform("win32");
  const warnings: string[] = [];
  const output = await sweep({ onWarning: (warning) => warnings.push(warning) });
  release();
  expect(fs.existsSync(recent)).toBe(true);
  expect(fs.existsSync(old)).toBe(false);
  expect(fs.existsSync(live)).toBe(true);
  expect(warnings).toContainEqual(
    expect.stringMatching(/Win001: .*keeping it until it is 24 hours old/u),
  );
  expect(warnings).toContainEqual(expect.stringContaining(`${old} by age`));
  expect(output).toContain(`Removed abandoned update inspection repository: ${old}`);
});
