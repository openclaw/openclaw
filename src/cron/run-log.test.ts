import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  appendCronRunLog,
  readCronRunLogEntries,
  resolveCronRunLogPath,
} from "./run-log.js";

describe("cron run log", () => {
  it("resolves a flat store path to cron.runs.jsonl", () => {
    const storePath = path.join(os.tmpdir(), "cron.json");
    const p = resolveCronRunLogPath({ storePath, jobId: "job-1" });
    expect(p.endsWith(path.join(os.tmpdir(), "cron.runs.jsonl"))).toBe(true);
  });

  it("resolves jobs.json to per-job runs/<jobId>.jsonl", () => {
    const storePath = path.join(os.tmpdir(), "cron", "jobs.json");
    const p = resolveCronRunLogPath({ storePath, jobId: "job-1" });
    expect(
      p.endsWith(path.join(os.tmpdir(), "cron", "runs", "job-1.jsonl")),
    ).toBe(true);
  });

  it("appends JSONL and prunes by line count", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-cron-log-"));
    const logPath = path.join(dir, "cron.runs.jsonl");

    for (let i = 0; i < 10; i++) {
      await appendCronRunLog(
        logPath,
        {
          ts: 1000 + i,
          jobId: "job-1",
          action: "finished",
          status: "ok",
          durationMs: i,
        },
        { maxBytes: 1, keepLines: 3 },
      );
    }

    const raw = await fs.readFile(logPath, "utf-8");
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    expect(lines.length).toBe(3);
    const last = JSON.parse(lines[2] ?? "{}") as { ts?: number };
    expect(last.ts).toBe(1009);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reads newest entries and filters by jobId", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdis-cron-log-read-"),
    );
    const logPath = path.join(dir, "cron.runs.jsonl");

    await appendCronRunLog(logPath, {
      ts: 1,
      jobId: "a",
      action: "finished",
      status: "ok",
    });
    await appendCronRunLog(logPath, {
      ts: 2,
      jobId: "b",
      action: "finished",
      status: "error",
      error: "nope",
      summary: "oops",
    });
    await appendCronRunLog(logPath, {
      ts: 3,
      jobId: "a",
      action: "finished",
      status: "skipped",
    });

    const all = await readCronRunLogEntries(logPath, { limit: 10 });
    expect(all.map((e) => e.jobId)).toEqual(["a", "b", "a"]);

    const onlyA = await readCronRunLogEntries(logPath, {
      limit: 10,
      jobId: "a",
    });
    expect(onlyA.map((e) => e.ts)).toEqual([1, 3]);

    const lastOne = await readCronRunLogEntries(logPath, { limit: 1 });
    expect(lastOne.map((e) => e.ts)).toEqual([3]);

    const onlyB = await readCronRunLogEntries(logPath, {
      limit: 10,
      jobId: "b",
    });
    expect(onlyB[0]?.summary).toBe("oops");

    await fs.rm(dir, { recursive: true, force: true });
  });
});
