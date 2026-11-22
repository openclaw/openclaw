import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  acquireUpdateLock,
  allocateStaging,
  createTrialPending,
  publishStaging,
  readUpdateLock,
  releaseUpdateLock,
  writeTrial,
} from "./store.js";

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
async function prefix() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-store-"));
  directories.push(dir);
  return dir;
}

it("admits one live prepare owner and reclaims a dead PID or an expired deadline", async () => {
  const dir = await prefix();
  const input = { runId: "first", pid: process.pid, deadlineMs: 60_000 };
  expect((await acquireUpdateLock(input, dir)).acquired).toBe(true);
  expect((await acquireUpdateLock({ ...input, runId: "second" }, dir)).acquired).toBe(false);
  expect(await readUpdateLock(dir)).toMatchObject({ runId: "first", dead: false });
  await releaseUpdateLock(dir);

  const owner = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await once(owner, "exit");
  expect(owner.pid).toBeTypeOf("number");
  await acquireUpdateLock({ ...input, runId: "dead-pid", pid: owner.pid! }, dir);
  expect(await readUpdateLock(dir)).toMatchObject({ dead: true });
  expect(await acquireUpdateLock({ ...input, runId: "replacement" }, dir)).toMatchObject({
    acquired: true,
    previous: { runId: "dead-pid" },
  });
  await releaseUpdateLock(dir);

  await acquireUpdateLock({ ...input, runId: "expired", deadlineMs: -1 }, dir);
  expect(await readUpdateLock(dir)).toMatchObject({ pid: process.pid, dead: true });
  expect(await acquireUpdateLock({ ...input, runId: "after-deadline" }, dir)).toMatchObject({
    acquired: true,
    previous: { runId: "expired" },
  });
});

it("publishes the prepared tree by rename and admits no overlapping trial", async () => {
  const dir = await prefix();
  const stage = await allocateStaging({ kind: "package", id: "candidate" }, dir);
  await fs.mkdir(stage.releaseRoot, { recursive: true });
  await fs.writeFile(path.join(stage.releaseRoot, "package.json"), '{"version":"2.0.0"}');
  const releaseRoot = await publishStaging(stage);
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
