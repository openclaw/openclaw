import fsSync from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import timers from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as pressure from "../../infra/host-io-pressure.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { runCommandWithTimeout } from "../../process/exec.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

it("bounds unlink bursts and waits for slow commits even with no PSI pressure", async () => {
  const root = directories.make("retired-worktree-batches-");
  const retired = path.join(root, "retired");
  await fs.mkdir(retired);
  for (let index = 0; index < 260; index++) {
    await fs.writeFile(path.join(retired, String(index)), "x");
  }
  const batches: number[] = [];
  let remaining = 260;
  const probe = vi.fn().mockResolvedValue(false);
  vi.spyOn(pressure, "createHostIoPressureProbe").mockReturnValue(probe);
  const pauses = vi.spyOn(timers, "setTimeout").mockImplementation(async () => {
    const next = fsSync.readdirSync(retired).length;
    batches.push(remaining - next);
    remaining = next;
    if (batches.length === 1) {
      probe.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    }
  });
  const argv = process.argv;
  syncBuiltinESMExports();
  process.argv = [argv[0]!, argv[1]!, retired];
  try {
    await import("./retired-worktree-cleanup.worker.js");
  } finally {
    process.argv = argv;
  }
  expect(batches).toEqual([128, 0, 0, 128]);
  expect(pauses.mock.calls.map(([ms]) => ms)).toEqual([100, 5_000, 5_000, 100]);
  expect(fsSync.existsSync(retired)).toBe(false);
});

it("paces large files separately and unlinks symlinks without visiting their targets", async () => {
  vi.resetModules();
  const root = directories.make("retired-worktree-bytes-");
  const retired = path.join(root, "retired");
  const outside = path.join(root, "preserved");
  await fs.mkdir(retired);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "keep"), "user data");
  await fs.symlink(outside, path.join(retired, "link"), "junction");
  for (const [name, size] of [
    ["a", 5],
    ["b", 5],
    ["large", 10],
  ] as const) {
    const file = await fs.open(path.join(retired, name), "w");
    await file.truncate(size * 1024 * 1024);
    await file.close();
  }
  const probeModule = await import("../../infra/host-io-pressure.js");
  vi.spyOn(probeModule, "createHostIoPressureProbe").mockReturnValue(async () => false);
  const batches: { entries: number; bytes: number }[] = [];
  let batch = { entries: 0, bytes: 0 };
  const unlink = fsSync.unlinkSync;
  const rmdir = fsSync.rmdirSync;
  vi.spyOn(fsSync, "unlinkSync").mockImplementation((target) => {
    const stat = fsSync.lstatSync(target);
    batch.entries++;
    batch.bytes += stat.isFile() ? stat.size : 0;
    unlink(target);
  });
  vi.spyOn(fsSync, "rmdirSync").mockImplementation((target) => {
    batch.entries++;
    rmdir(target);
  });
  vi.spyOn(timers, "setTimeout").mockImplementation(async () => {
    batches.push(batch);
    batch = { entries: 0, bytes: 0 };
  });
  syncBuiltinESMExports();
  const argv = process.argv;
  process.argv = [argv[0]!, argv[1]!, retired];
  try {
    await import("./retired-worktree-cleanup.worker.js");
  } finally {
    process.argv = argv;
  }
  batches.push(batch);
  expect(batches.length).toBeGreaterThanOrEqual(3);
  for (const observed of batches) {
    expect(observed.entries).toBeLessThanOrEqual(128);
    expect(observed.bytes <= 8 * 1024 * 1024 || observed.entries === 1).toBe(true);
  }
  expect(batches.reduce((sum, observed) => sum + observed.bytes, 0)).toBe(20 * 1024 * 1024);
  expect(await fs.readFile(path.join(outside, "keep"), "utf8")).toBe("user data");
  expect(fsSync.existsSync(retired)).toBe(false);
});

it("removes only the retired checkout and completes when it is already absent", async () => {
  const root = directories.make("retired-worktree-cleanup-");
  const retired = path.join(root, ".openclaw-removing-test");
  const preserved = path.join(root, "active.txt");
  await fs.mkdir(path.join(retired, "nested"), { recursive: true });
  await fs.writeFile(path.join(retired, "nested", "file.txt"), "retired bytes");
  await fs.writeFile(preserved, "active bytes");
  const argv = [
    process.execPath,
    ...resolveRuntimeWorkerArgv(
      resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.retiredWorktreeCleanup),
    ),
    retired,
  ];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await runCommandWithTimeout(argv, { timeoutMs: 10_000 });
    expect(result).toMatchObject({ code: 0, termination: "exit" });
    await expect(fs.stat(retired)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(preserved, "utf8")).toBe("active bytes");
  }
});
