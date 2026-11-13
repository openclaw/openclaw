import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  activateRuntimeSlot,
  confirmRuntimeSlot,
  ensureRuntimeSlots,
  readRuntimePointer,
  selectInactiveSlot,
} from "./runtime-slots.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const repoRoot = path.resolve(import.meta.dirname, "../..");
// The launcher runs under the service's Node, never the test runner's runtime.
const node = process.versions.bun ? "node" : process.execPath;
const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME };

/** A slot whose entry prints its name, then exits with the given code. */
function writeSlot(root: string, name: string, exitCode: number) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "openclaw.mjs"),
    `console.log(JSON.stringify({ slot: ${JSON.stringify(name)}, args: process.argv.slice(2), trial: process.env.OPENCLAW_RUNTIME_TRIAL ?? null, env: process.env.OPENCLAW_RUNTIME_SLOT }));\nprocess.exitCode = ${exitCode};\n`,
  );
}

async function createLayout() {
  const state = temporary.make("openclaw-runtime-slots-");
  const dir = path.join(state, "runtime");
  const origin = path.join(state, "origin");
  writeSlot(origin, "origin", 0);
  const umask = process.umask(0o077);
  try {
    await ensureRuntimeSlots({ dir, origin, packageRoot: repoRoot });
  } finally {
    process.umask(umask);
  }
  return { state, dir, origin: fs.realpathSync(origin) };
}

const start = (dir: string, args: string[] = ["gateway", "--port", "19001"]) => {
  const result = spawnSync(node, [path.join(dir, "launcher.mjs"), ...args], {
    encoding: "utf8",
    env: childEnv,
    timeout: 20_000,
  });
  return { status: result.status, stderr: result.stderr, ...JSON.parse(result.stdout) };
};

it("writes the launcher with explicit modes and starts the origin until an update flips the pointer", async () => {
  const { dir, origin } = await createLayout();
  expect(fs.statSync(path.join(dir, "launcher.mjs")).mode & 0o777).toBe(0o644);
  expect(fs.statSync(path.join(dir, "slots.json")).mode & 0o777).toBe(0o644);
  expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  expect(start(dir)).toMatchObject({
    slot: "origin",
    args: ["gateway", "--port", "19001"],
    env: origin,
  });
});

it("spends two trial starts on a failing slot, then returns to the previous slot", async () => {
  const { dir, origin } = await createLayout();
  const slot = selectInactiveSlot(dir, readRuntimePointer(dir)!);
  expect(path.basename(slot)).toBe("a");
  writeSlot(slot, "a", 1);
  activateRuntimeSlot(dir, slot);

  expect(start(dir)).toMatchObject({ slot: "a", status: 1, trial: "1" });
  expect(readRuntimePointer(dir)?.trial).toBe(1);
  expect(start(dir)).toMatchObject({ slot: "a", status: 1, trial: "1" });
  const third = start(dir);
  expect(third).toMatchObject({ slot: "origin", status: 0, trial: null });
  expect(third.stderr).toContain("did not start");
  expect(readRuntimePointer(dir)).toEqual({
    current: origin,
    previous: fs.realpathSync(slot),
    origin,
    failed: fs.realpathSync(slot),
  });
  // The next update stages the failed slot again, never the running one.
  expect(selectInactiveSlot(dir, readRuntimePointer(dir)!)).toBe(slot);
});

it("keeps a slot that its Gateway confirmed", async () => {
  const { dir } = await createLayout();
  const slot = selectInactiveSlot(dir, readRuntimePointer(dir)!);
  writeSlot(slot, "a", 0);
  activateRuntimeSlot(dir, slot);
  const first = start(dir);
  expect(first).toMatchObject({ slot: "a", trial: "1" });
  expect(
    confirmRuntimeSlot({
      ...process.env,
      OPENCLAW_STATE_DIR: path.dirname(dir),
      OPENCLAW_RUNTIME_SLOT: first.env,
    }),
  ).toBe(true);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    expect(start(dir)).toMatchObject({ slot: "a", trial: null });
  }
  expect(readRuntimePointer(dir)?.trial).toBeUndefined();
  // A CLI call reads the pointer and never spends a trial start.
  activateRuntimeSlot(dir, slot);
  const caller = path.join(path.dirname(dir), "cli.mjs");
  fs.writeFileSync(
    caller,
    `const { launchRuntime } = await import(${JSON.stringify(path.join(dir, "launcher.mjs"))});\nlaunchRuntime(${JSON.stringify(dir)}, ["status"], { start: false });\n`,
  );
  const cli = spawnSync(node, [caller], { encoding: "utf8", env: childEnv, timeout: 20_000 });
  expect(JSON.parse(cli.stdout)).toMatchObject({ slot: "a", args: ["status"], trial: null });
  expect(readRuntimePointer(dir)?.trial).toBe(2);
});

it("never stages the slot that the running Gateway uses", async () => {
  const { dir, origin } = await createLayout();
  const first = selectInactiveSlot(dir, readRuntimePointer(dir)!);
  writeSlot(first, "a", 0);
  activateRuntimeSlot(dir, first);
  // No Gateway started first: the origin still serves, so a second update replaces first.
  expect(selectInactiveSlot(dir, readRuntimePointer(dir)!)).toBe(first);
  activateRuntimeSlot(dir, first);
  expect(readRuntimePointer(dir)).toMatchObject({ previous: origin, trial: 2 });
  // Once first has started, it may be serving: the next update takes the other slot.
  start(dir);
  const second = selectInactiveSlot(dir, readRuntimePointer(dir)!);
  expect(path.basename(second)).toBe("b");
  activateRuntimeSlot(dir, second);
  expect(readRuntimePointer(dir)).toMatchObject({ previous: fs.realpathSync(first), trial: 2 });
});
