import { afterEach, expect, it, vi } from "vitest";
import { createBackupProgressLogger } from "./backup-progress.js";

afterEach(() => vi.useRealTimers());

it("bounds frequent byte progress and summarizes completed stages", () => {
  vi.useFakeTimers();
  const log = vi.fn();
  const report = createBackupProgressLogger(log);
  report({ stage: "sqlite-online-copy", phase: "start", bytes: 8192 });
  for (let index = 0; index < 1000; index += 1) {
    report({ stage: "sqlite-online-copy", phase: "progress", bytes: index });
  }
  expect(log).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(15_000);
  report({ stage: "sqlite-online-copy", phase: "progress", bytes: 4096 });
  vi.advanceTimersByTime(1000);
  report({ stage: "sqlite-online-copy", phase: "done", bytes: 8192 });
  report({ stage: "sqlite-vacuum", phase: "start", bytes: 8192 });
  vi.advanceTimersByTime(2000);
  report({ stage: "sqlite-vacuum", phase: "done", bytes: 4096 });
  report.finish();
  expect(log).toHaveBeenCalledTimes(5);
  expect(log.mock.calls.map(([line]) => line)).toEqual([
    "Backup progress: stage=sqlite-online-copy phase=start bytes=8192",
    "Backup progress: stage=sqlite-online-copy phase=progress bytes=4096",
    "Backup progress: stage=sqlite-vacuum phase=start bytes=8192",
    "Backup progress: stage=sqlite-online-copy phase=summary runs=1 bytes=8192 outputBytes=0 elapsedMs=16000 complete=true",
    "Backup progress: stage=sqlite-vacuum phase=summary runs=1 bytes=4096 outputBytes=0 elapsedMs=2000 complete=true",
  ]);
});

it("retains a large in-flight database and aggregate totals after the live line cap", () => {
  vi.useFakeTimers();
  const log = vi.fn();
  const report = createBackupProgressLogger(log);
  for (let index = 0; index < 100; index += 1) {
    report({ stage: "sqlite-online-copy", phase: "start", bytes: 1024 });
    vi.advanceTimersByTime(15_000);
    report({ stage: "sqlite-online-copy", phase: "done", bytes: 1024 });
  }
  report({ stage: "sqlite-online-copy", phase: "start", sourceBytes: 8 * 1024 ** 3 });
  vi.advanceTimersByTime(30_000);
  report({ stage: "sqlite-online-copy", phase: "progress", bytes: 4 * 1024 ** 3 });
  report.finish();

  const lines = log.mock.calls.map(([line]) => line as string);
  expect(lines).toContain(
    "Backup progress: stage=sqlite-online-copy phase=start sourceBytes=8589934592",
  );
  expect(lines.at(-1)).toBe(
    "Backup progress: stage=sqlite-online-copy phase=summary runs=100 bytes=4295069696 outputBytes=0 elapsedMs=1530000 complete=false",
  );
  expect(lines.length).toBeLessThanOrEqual(102);
});

it("shows the first start of a new stage immediately and does not count its input as completed", () => {
  vi.useFakeTimers();
  const log = vi.fn();
  const report = createBackupProgressLogger(log);
  report({ stage: "plan", phase: "start" });
  report({ stage: "sqlite-source-integrity", phase: "start", sourceBytes: 512 * 1024 ** 2 });
  report.finish();
  expect(log.mock.calls.map(([line]) => line)).toEqual([
    "Backup progress: stage=plan phase=start",
    "Backup progress: stage=sqlite-source-integrity phase=start sourceBytes=536870912",
    "Backup progress: stage=plan phase=summary runs=0 bytes=0 outputBytes=0 elapsedMs=0 complete=false",
    "Backup progress: stage=sqlite-source-integrity phase=summary runs=0 bytes=0 outputBytes=0 elapsedMs=0 complete=false",
  ]);
});

it("does not claim an 8 GiB source was copied when acquisition fails before progress", () => {
  vi.useFakeTimers();
  const log = vi.fn();
  const report = createBackupProgressLogger(log);
  report({ stage: "sqlite-source-acquisition", phase: "start", sourceBytes: 8 * 1024 ** 3 });
  vi.advanceTimersByTime(20_000);
  report.finish();
  expect(log.mock.calls.at(-1)?.[0]).toBe(
    "Backup progress: stage=sqlite-source-acquisition phase=summary runs=0 bytes=0 outputBytes=0 elapsedMs=20000 complete=false",
  );
});
