import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import {
  acquireUpdateLock,
  allocateStaging,
  createTrialPending,
  publishStaging,
  readUpdateLock,
  retireDeadUpdateLock,
  writeTrial,
  type UpdateLock,
} from "./store.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
async function prefix() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-store-"));
  directories.push(dir);
  return dir;
}

async function seedDeadLock(dir: string): Promise<UpdateLock> {
  const owner = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await once(owner, "exit");
  expect(owner.pid).toBeTypeOf("number");
  const lock = { runId: "dead-pid", pid: owner.pid!, startedAt: Date.now(), deadlineMs: 60_000 };
  await fs.mkdir(path.join(dir, "releases"), { recursive: true });
  await fs.writeFile(path.join(dir, "releases", ".update.lock"), JSON.stringify(lock));
  return lock;
}

it("keeps one live owner past its budget and reclaims a dead owner", async () => {
  const dir = await prefix();
  const first = await acquireUpdateLock({ runId: "first", deadlineMs: -1 }, dir);
  expect(first.acquired).toBe(true);
  if (!first.acquired) {
    throw new Error("The first preparation did not acquire custody");
  }
  try {
    expect((await acquireUpdateLock({ runId: "second", deadlineMs: 60_000 }, dir)).acquired).toBe(
      false,
    );
    expect(await readUpdateLock(dir)).toMatchObject({
      runId: "first",
      pid: process.pid,
      dead: false,
    });
  } finally {
    await first.release();
  }
  await seedDeadLock(dir);
  expect(await readUpdateLock(dir)).toMatchObject({ dead: true });
  const replacement = await acquireUpdateLock({ runId: "replacement", deadlineMs: 60_000 }, dir);
  expect(replacement.acquired).toBe(true);
  if (replacement.acquired) {
    expect(await readUpdateLock(dir)).toMatchObject({ runId: "replacement", dead: false });
    await replacement.release();
  }
  expect(await readUpdateLock(dir)).toBeNull();
});

it("serializes contenders while removing one dead owner's lock", async ({ signal }) => {
  const dir = await prefix();
  await seedDeadLock(dir);
  const file = path.join(dir, "releases", ".update.lock");
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const rm = fs.rm.bind(fs);
  let delayed = false;
  vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
    if (target === file && !delayed) {
      delayed = true;
      entered.resolve();
      await resume.promise;
    }
    return rm(target, options);
  });
  const first = acquireUpdateLock({ runId: "first", deadlineMs: 60_000 }, dir);
  let second: Awaited<typeof first> | undefined;
  try {
    await withinTest(entered.promise, signal);
    second = await acquireUpdateLock({ runId: "second", deadlineMs: 60_000 }, dir);
  } finally {
    resume.resolve();
  }
  const settled = await first;
  try {
    expect([settled, second].filter((result) => result?.acquired)).toHaveLength(1);
    expect(await readUpdateLock(dir)).toMatchObject({
      runId: settled.acquired ? "first" : "second",
      dead: false,
    });
  } finally {
    if (settled.acquired) {
      await settled.release();
    }
    if (second?.acquired) {
      await second.release();
    }
  }
});

it("preserves a replacement during late release and stale readiness cleanup", async () => {
  const dir = await prefix();
  const stale = await seedDeadLock(dir);
  const first = await acquireUpdateLock({ runId: "first", deadlineMs: 60_000 }, dir);
  if (!first.acquired) {
    throw new Error("The first preparation did not acquire custody");
  }
  const file = path.join(dir, "releases", ".update.lock");
  await fs.rename(file, `${file}.retired`);
  await fs.writeFile(
    file,
    JSON.stringify({
      runId: "replacement",
      pid: process.pid,
      startedAt: Date.now(),
      deadlineMs: 60_000,
    }),
  );
  try {
    await first.release();
    await retireDeadUpdateLock(stale, dir);
    expect(await readUpdateLock(dir)).toMatchObject({ runId: "replacement", dead: false });
  } finally {
    await first.release();
  }
});

it("publishes the prepared tree by rename and admits no overlapping trial", async () => {
  const dir = await prefix();
  const stage = await allocateStaging({ kind: "package", id: "candidate" }, dir);
  await fs.mkdir(stage.releaseRoot, { recursive: true });
  expect(stage.releaseRoot).toBe(path.join(dir, "releases", ".staging-candidate", "openclaw"));
  await fs.writeFile(path.join(stage.releaseRoot, "package.json"), '{"version":"2.0.0"}');
  const releaseRoot = await publishStaging(stage);
  expect(releaseRoot).toBe(path.join(dir, "releases", "candidate", "openclaw"));
  expect(await fs.readFile(path.join(releaseRoot, "package.json"), "utf8")).toContain('"2.0.0"');
  await expect(fs.stat(stage.path)).rejects.toMatchObject({ code: "ENOENT" });
  const input = {
    runId: "trial",
    target: path.relative(dir, releaseRoot),
    previous: "releases/old/openclaw",
    version: "2.0.0",
  };
  const trial = await createTrialPending(input, dir);
  for (const phase of ["pending", "trial", "restoring"] as const) {
    await writeTrial({ ...trial, phase }, dir);
    await expect(createTrialPending(input, dir)).rejects.toThrow("already");
  }
  await writeTrial({ ...trial, phase: "committed" }, dir);
  expect(await createTrialPending({ ...input, runId: "next" }, dir)).toMatchObject({
    phase: "pending",
    runId: "next",
    attempts: 0,
  });
});
