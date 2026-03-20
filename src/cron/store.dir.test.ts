/**
 * Tests for the directory-based cron job store.
 * Related: #37630
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hasCronJobsDir,
  isDisabledFilename,
  jobIdFromFilename,
  loadCronStoreDir,
  migrateCronStoreToDir,
  removeCronJobFile,
  saveCronJobFile,
  saveCronStore,
  slugifyCronJobName,
} from "./store.js";
import type { CronJob } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oc-cron-test-"));
}

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "test-job",
    name: "Test Job",
    schedule: { kind: "every", everyMs: 3600000 },
    payload: { kind: "systemEvent", text: "hello" },
    sessionTarget: "main",
    enabled: true,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    state: "idle",
    ...overrides,
  } as CronJob;
}

// ---------------------------------------------------------------------------
// Slug / filename helpers
// ---------------------------------------------------------------------------

describe("slugifyCronJobName", () => {
  it("lowercases and replaces spaces with dashes", () => {
    expect(slugifyCronJobName("Daily Brew")).toBe("daily-brew");
  });

  it("collapses multiple separators", () => {
    expect(slugifyCronJobName("SEO -- Report!")).toBe("seo-report");
  });

  it("falls back to raw id for non-slugifiable input", () => {
    expect(slugifyCronJobName("---")).toBe("---");
  });
});

describe("jobIdFromFilename", () => {
  it("strips .json extension", () => {
    expect(jobIdFromFilename("seo-report.json")).toBe("seo-report");
  });

  it("strips _disabled. compound prefix", () => {
    expect(jobIdFromFilename("_disabled.seo-report.json")).toBe("seo-report");
  });

  it("strips disabled. prefix", () => {
    expect(jobIdFromFilename("disabled.seo-report.json")).toBe("seo-report");
  });

  it("strips single _ prefix", () => {
    expect(jobIdFromFilename("_seo-report.json")).toBe("seo-report");
  });
});

describe("isDisabledFilename", () => {
  it("returns true for _ prefix", () => {
    expect(isDisabledFilename("_daily-brew.json")).toBe(true);
  });

  it("returns true for disabled. prefix", () => {
    expect(isDisabledFilename("disabled.daily-brew.json")).toBe(true);
  });

  it("returns false for normal file", () => {
    expect(isDisabledFilename("daily-brew.json")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasCronJobsDir
// ---------------------------------------------------------------------------

describe("hasCronJobsDir", () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("returns false when jobs/ does not exist", async () => {
    expect(await hasCronJobsDir(dir)).toBe(false);
  });

  it("returns true when jobs/ exists", async () => {
    fs.mkdirSync(path.join(dir, "jobs"));
    expect(await hasCronJobsDir(dir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadCronStoreDir
// ---------------------------------------------------------------------------

describe("loadCronStoreDir", () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("returns empty store when jobs/ does not exist", async () => {
    const store = await loadCronStoreDir(dir);
    expect(store.jobs).toHaveLength(0);
  });

  it("loads a single job file", async () => {
    const jobsDir = path.join(dir, "jobs");
    fs.mkdirSync(jobsDir);
    const job = makeJob({ id: "my-job", name: "My Job" });
    fs.writeFileSync(path.join(jobsDir, "my-job.json"), JSON.stringify(job));
    const store = await loadCronStoreDir(dir);
    expect(store.jobs).toHaveLength(1);
    expect(store.jobs[0].id).toBe("my-job");
  });

  it("infers id from filename when absent in file", async () => {
    const jobsDir = path.join(dir, "jobs");
    fs.mkdirSync(jobsDir);
    const { id: _id, ...jobWithoutId } = makeJob({ name: "Infer Me" });
    fs.writeFileSync(path.join(jobsDir, "infer-me.json"), JSON.stringify(jobWithoutId));
    const store = await loadCronStoreDir(dir);
    expect(store.jobs[0].id).toBe("infer-me");
  });

  it("marks _ prefixed files as enabled: false", async () => {
    const jobsDir = path.join(dir, "jobs");
    fs.mkdirSync(jobsDir);
    const job = makeJob({ id: "daily-brew", enabled: true });
    fs.writeFileSync(path.join(jobsDir, "_daily-brew.json"), JSON.stringify(job));
    const store = await loadCronStoreDir(dir);
    expect(store.jobs[0].enabled).toBe(false);
  });

  it("marks disabled. prefixed files as enabled: false", async () => {
    const jobsDir = path.join(dir, "jobs");
    fs.mkdirSync(jobsDir);
    const job = makeJob({ id: "seo-report", enabled: true });
    fs.writeFileSync(path.join(jobsDir, "disabled.seo-report.json"), JSON.stringify(job));
    const store = await loadCronStoreDir(dir);
    expect(store.jobs[0].enabled).toBe(false);
  });

  it("ignores non-.json files", async () => {
    const jobsDir = path.join(dir, "jobs");
    fs.mkdirSync(jobsDir);
    fs.writeFileSync(path.join(jobsDir, "README.md"), "# notes");
    fs.writeFileSync(path.join(jobsDir, "my-job.json"), JSON.stringify(makeJob()));
    const store = await loadCronStoreDir(dir);
    expect(store.jobs).toHaveLength(1);
  });

  it("throws on malformed JSON", async () => {
    const jobsDir = path.join(dir, "jobs");
    fs.mkdirSync(jobsDir);
    fs.writeFileSync(path.join(jobsDir, "bad.json"), "{ not json }}}");
    await expect(loadCronStoreDir(dir)).rejects.toThrow(/Failed to parse/);
  });
});

// ---------------------------------------------------------------------------
// saveCronJobFile / removeCronJobFile
// ---------------------------------------------------------------------------

describe("saveCronJobFile", () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("creates jobs/ directory and writes file", async () => {
    const job = makeJob({ id: "my-job", name: "My Job" });
    await saveCronJobFile(dir, job);
    const filePath = path.join(dir, "jobs", "my-job.json");
    expect(fs.existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(parsed.id).toBe("my-job");
  });

  it("slugifies the job name for the filename", async () => {
    const job = makeJob({ id: "brew-1", name: "Daily Brew" });
    await saveCronJobFile(dir, job);
    expect(fs.existsSync(path.join(dir, "jobs", "daily-brew.json"))).toBe(true);
  });
});

describe("removeCronJobFile", () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("removes the correct job file", async () => {
    const job = makeJob({ id: "my-job", name: "My Job" });
    await saveCronJobFile(dir, job);
    const removed = await removeCronJobFile(dir, "my-job");
    expect(removed).toBe(true);
    expect(fs.existsSync(path.join(dir, "jobs", "my-job.json"))).toBe(false);
  });

  it("returns false when job file not found", async () => {
    fs.mkdirSync(path.join(dir, "jobs"));
    expect(await removeCronJobFile(dir, "nonexistent")).toBe(false);
  });

  it("removes disabled-prefixed files by id", async () => {
    const jobsDir = path.join(dir, "jobs");
    fs.mkdirSync(jobsDir);
    const job = makeJob({ id: "daily-brew" });
    fs.writeFileSync(path.join(jobsDir, "_daily-brew.json"), JSON.stringify(job));
    const removed = await removeCronJobFile(dir, "daily-brew");
    expect(removed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// migrateCronStoreToDir
// ---------------------------------------------------------------------------

describe("migrateCronStoreToDir", () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("splits jobs.json into individual files", async () => {
    const storePath = path.join(dir, "jobs.json");
    const jobs = [
      makeJob({ id: "job-a", name: "Job A" }),
      makeJob({ id: "job-b", name: "Job B" }),
    ];
    await saveCronStore(storePath, { version: 1, jobs });
    const result = await migrateCronStoreToDir(storePath, dir);
    expect(result.migrated).toBe(2);
    expect(result.skipped).toBe(0);
    expect(fs.existsSync(path.join(dir, "jobs", "job-a.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "jobs", "job-b.json"))).toBe(true);
  });

  it("returns migrated=0 for empty store", async () => {
    const storePath = path.join(dir, "jobs.json");
    await saveCronStore(storePath, { version: 1, jobs: [] });
    const result = await migrateCronStoreToDir(storePath, dir);
    expect(result.migrated).toBe(0);
  });
});
