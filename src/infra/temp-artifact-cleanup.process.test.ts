import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { isContainerEnvironment } from "./container-environment.js";
import { maintainRetainedUpdateRuntimes } from "./temp-artifact-cleanup.js";
import { createUpdateRun, finishUpdateRun } from "./update-run-ledger.js";
import { readUpdateRunSettlement } from "./update-run-settlement.js";

// Real census and real children: each child is owned here and killed before its directory goes.
const dirs = useAutoCleanupTempDirTracker(afterEach);
const children = new Set<ChildProcess>();
afterEach(async () => {
  await Promise.all([...children].map(stop));
  children.clear();
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

const translated = process.arch === "x64" && os.cpus()[0]?.model.includes("Apple");
// Process titles replace argv only where the census reads native argv.
const native =
  (process.platform === "darwin" || process.platform === "linux") &&
  !translated &&
  !isContainerEnvironment();

let base: string;
let checkout: string;
let env: { HOME: string; OPENCLAW_STATE_DIR: string };

beforeEach(() => {
  base = fs.realpathSync(dirs.make("runtime-custody-"));
  checkout = path.join(base, "checkout");
  fs.mkdirSync(checkout);
  fs.writeFileSync(path.join(checkout, "package.json"), '{"name":"openclaw"}');
  env = { HOME: base, OPENCLAW_STATE_DIR: path.join(base, "state") };
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

/** Resolves after the child's own code ran, so its title, argv and cwd are in place. */
async function start(script: string, options: { cwd?: string; argv?: string[] } = {}) {
  const child = spawn(process.execPath, [...(options.argv ?? ["-e"]), script], {
    cwd: options.cwd ?? base,
    env: { PATH: process.env.PATH, HOME: base },
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.add(child);
  await once(child.stdout, "data");
  return child;
}

const idle = 'console.log("ready"); setInterval(() => {}, 1e9);';
// The CLI preaction and the Gateway run loop set this, and libuv writes it over argv.
const startGateway = () => start(`process.title = "openclaw-gateway"; ${idle}`);

/** A projected runtime, stamped with the update run that created it when one is given. */
function runtime(name: string, runId?: string): string {
  const directory = path.join(base, `openclaw-update-runtime-${name}`);
  const root = path.join(
    directory,
    "tree",
    Buffer.from(path.parse(checkout).root).toString("hex"),
    path.relative(path.parse(checkout).root, checkout),
  );
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", ...(runId ? { openclawUpdateRunId: runId } : {}) }),
  );
  return directory;
}

function run(settled: boolean): string {
  const created = createUpdateRun({ trigger: "cli" }, { env });
  if (settled) {
    finishUpdateRun(created.runId, { status: "succeeded" }, { env });
  }
  return created.runId;
}

const sweep = () =>
  maintainRetainedUpdateRuntimes({
    packageRoots: [checkout],
    repair: true,
    assertCurrent() {},
    readUpdateRun: (runId) => readUpdateRunSettlement(runId, env),
  });

/**
 * One unreadable host process fails a real census as a whole, for instance one mid-exec.
 * The next sweep is the product's own answer to that, so each attempt here is a fresh sweep.
 */
async function sweepFor(expected: string): Promise<string[]> {
  const output: string[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    output.push(...(await sweep()));
    if (output.some((line) => line.includes(expected))) {
      break;
    }
  }
  return output;
}

it.runIf(native)("reclaims a settled run's runtime while a titled Gateway runs", async () => {
  const directory = runtime("Settld", run(true));
  const gateway = await startGateway();
  const removed = `Removed abandoned updater runtime: ${directory}`;
  expect(await sweepFor(removed)).toContain(removed);
  expect(fs.existsSync(directory)).toBe(false);
  expect(gateway.exitCode).toBeNull();
});

it.runIf(native)("keeps a settled run's runtime while a process runs from it", async () => {
  const directory = runtime("InUse1", run(true));
  const script = path.join(directory, "worker.mjs");
  fs.writeFileSync(script, idle);
  await startGateway();
  const holder = await start(script, { argv: [] });
  const held = `PIDs: ${holder.pid}`;
  expect(await sweepFor(held)).toContainEqual(expect.stringContaining(held));
  expect(fs.existsSync(script)).toBe(true);
});

it.runIf(native)("keeps a settled run's runtime while a process works inside it", async () => {
  const directory = runtime("InUse2", run(true));
  const holder = await start(idle, { cwd: path.join(directory, "tree") });
  const held = `PIDs: ${holder.pid}`;
  expect(await sweepFor(held)).toContainEqual(expect.stringContaining(held));
  expect(fs.existsSync(directory)).toBe(true);
});

it.runIf(native)("keeps a runtime whose run has not settled", async () => {
  const runId = run(false);
  const directory = runtime("Runnin", runId);
  const kept = `its update run ${runId} has not settled`;
  expect(await sweepFor(kept)).toContainEqual(expect.stringContaining(kept));
  expect(fs.existsSync(directory)).toBe(true);
});

it.runIf(native)("keeps an unstamped runtime while any OpenClaw process runs", async () => {
  // Older updaters leave no stamp, so nothing shows their run settled: the existing rule holds.
  const directory = runtime("Legacy");
  const gateway = await startGateway();
  const held = `PIDs: ${gateway.pid}`;
  expect(await sweepFor(held)).toContainEqual(expect.stringContaining(held));
  expect(fs.existsSync(directory)).toBe(true);
});

it.runIf(native)("treats a stamp from another state directory like no stamp", async () => {
  const directory = runtime("Foreig", "00000000-0000-4000-8000-0000000000ff");
  const gateway = await startGateway();
  const held = `PIDs: ${gateway.pid}`;
  expect(await sweepFor(held)).toContainEqual(expect.stringContaining(held));
  expect(fs.existsSync(directory)).toBe(true);
});
