import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { buildHeartbeatCronSummary } from "./heartbeat-cron-summary.js";

describe("buildHeartbeatCronSummary", () => {
  const tmpDirs: string[] = [];

  async function createTmpCronStore(jobs: unknown[]) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-summary-"));
    tmpDirs.push(dir);
    const storePath = path.join(dir, "jobs.json");
    await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs }));
    return storePath;
  }

  afterEach(async () => {
    for (const dir of tmpDirs) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tmpDirs.length = 0;
  });

  it("returns undefined when no cron jobs exist", async () => {
    const storePath = await createTmpCronStore([]);
    const result = await buildHeartbeatCronSummary({
      cfg: { cron: { store: storePath } } as OpenClawConfig,
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when all jobs are disabled", async () => {
    const storePath = await createTmpCronStore([
      {
        id: "1",
        name: "disabled-job",
        enabled: false,
        schedule: { kind: "cron", expr: "0 * * * *" },
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "test" },
        state: {},
      },
    ]);
    const result = await buildHeartbeatCronSummary({
      cfg: { cron: { store: storePath } } as OpenClawConfig,
    });
    expect(result).toBeUndefined();
  });

  it("includes enabled jobs with schedule and target info", async () => {
    const storePath = await createTmpCronStore([
      {
        id: "1",
        name: "ai-news-daily",
        enabled: true,
        schedule: { kind: "cron", expr: "0 22 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "send news" },
        state: {},
      },
      {
        id: "2",
        name: "morning-report",
        enabled: true,
        schedule: { kind: "cron", expr: "30 22 * * *" },
        sessionTarget: "main",
        payload: { kind: "systemEvent", text: "check report" },
        state: {},
      },
    ]);
    const result = await buildHeartbeatCronSummary({
      cfg: { cron: { store: storePath } } as OpenClawConfig,
    });
    expect(result).toBeDefined();
    expect(result).toContain("Active cron jobs");
    expect(result).toContain("do NOT duplicate");
    expect(result).toContain("ai-news-daily");
    expect(result).toContain('cron "0 22 * * *" (UTC)');
    expect(result).toContain("isolated, agentTurn");
    expect(result).toContain("morning-report");
    expect(result).toContain("main, systemEvent");
  });

  it("handles every-style schedules", async () => {
    const storePath = await createTmpCronStore([
      {
        id: "1",
        name: "backup",
        enabled: true,
        schedule: { kind: "every", everyMs: 21600000 },
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "backup" },
        state: {},
      },
    ]);
    const result = await buildHeartbeatCronSummary({
      cfg: { cron: { store: storePath } } as OpenClawConfig,
    });
    expect(result).toContain("every 360m");
  });

  it("handles at-style schedules", async () => {
    const storePath = await createTmpCronStore([
      {
        id: "1",
        name: "one-shot",
        enabled: true,
        schedule: { kind: "at", at: "2026-02-20T10:00:00Z" },
        sessionTarget: "main",
        payload: { kind: "systemEvent", text: "reminder" },
        state: {},
      },
    ]);
    const result = await buildHeartbeatCronSummary({
      cfg: { cron: { store: storePath } } as OpenClawConfig,
    });
    expect(result).toContain("once at 2026-02-20T10:00:00Z");
  });

  it("returns undefined when cron store path does not exist", async () => {
    const result = await buildHeartbeatCronSummary({
      cfg: { cron: { store: "/tmp/nonexistent-cron-store-12345/jobs.json" } } as OpenClawConfig,
    });
    expect(result).toBeUndefined();
  });

  it("filters out disabled jobs from summary", async () => {
    const storePath = await createTmpCronStore([
      {
        id: "1",
        name: "enabled-job",
        enabled: true,
        schedule: { kind: "cron", expr: "0 * * * *" },
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "test" },
        state: {},
      },
      {
        id: "2",
        name: "disabled-job",
        enabled: false,
        schedule: { kind: "cron", expr: "0 * * * *" },
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "test" },
        state: {},
      },
    ]);
    const result = await buildHeartbeatCronSummary({
      cfg: { cron: { store: storePath } } as OpenClawConfig,
    });
    expect(result).toContain("enabled-job");
    expect(result).not.toContain("disabled-job");
  });
});
