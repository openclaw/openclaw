import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { loadCronStore, saveCronStore } from "../../../cron/store.js";
import { autoMigrateLegacyCronStore } from "./auto-migration.js";

let tempRoot: string | null = null;

async function makeTempStorePath() {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-auto-migration-"));
  return path.join(tempRoot, "cron", "jobs.json");
}

afterEach(async () => {
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

function createCronConfig(storePath: string): OpenClawConfig {
  return {
    cron: {
      store: storePath,
      webhook: "https://example.invalid/cron-finished",
    },
  };
}

function createLegacyCronJob(overrides: Record<string, unknown> = {}) {
  return {
    jobId: "legacy-job",
    name: "Legacy job",
    notify: true,
    createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
    updatedAtMs: Date.parse("2026-02-02T00:00:00.000Z"),
    schedule: { kind: "cron", cron: "0 7 * * *", tz: "UTC" },
    payload: {
      kind: "systemEvent",
      text: "Morning brief",
    },
    state: {},
    ...overrides,
  };
}

function createCurrentCronJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "sqlite-job",
    name: "SQLite job",
    enabled: true,
    createdAtMs: Date.parse("2026-02-03T00:00:00.000Z"),
    updatedAtMs: Date.parse("2026-02-03T00:00:00.000Z"),
    schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "systemEvent",
      text: "SQLite brief",
    },
    state: {},
    ...overrides,
  };
}

async function writeLegacyCronStore(storePath: string, jobs: Array<Record<string, unknown>>) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(
    storePath,
    JSON.stringify(
      {
        version: 1,
        jobs,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

describe("autoMigrateLegacyCronStore", () => {
  it("imports legacy-only jobs into SQLite and archives legacy cron files before runtime reads", async () => {
    const storePath = await makeTempStorePath();
    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        createCurrentCronJob({
          id: "legacy-job",
          name: "SQLite wins",
        }) as never,
      ],
    });
    await writeLegacyCronStore(storePath, [
      createLegacyCronJob({
        name: "Stale duplicate",
      }),
      createLegacyCronJob({
        jobId: "legacy-only",
        name: "Legacy only",
      }),
    ]);

    const result = await autoMigrateLegacyCronStore({ cfg: createCronConfig(storePath) });

    const jobs = (await loadCronStore(storePath)).jobs as unknown as Array<Record<string, unknown>>;
    expect(jobs.map((job) => job.id)).toEqual(["legacy-job", "legacy-only"]);
    expect(jobs[0]?.name).toBe("SQLite wins");
    expect(jobs[1]?.name).toBe("Legacy only");
    const legacyOnly = requireRecord(jobs[1], "legacy-only job");
    expect(legacyOnly.jobId).toBeUndefined();
    expect(legacyOnly.notify).toBeUndefined();
    expect(requireRecord(legacyOnly.delivery, "cron delivery").mode).toBe("webhook");
    await expect(fs.stat(`${storePath}.migrated`)).resolves.toBeTruthy();
    expect(result.changes.join("\n")).toContain("Cron store migrated to SQLite");
    expect(result.warnings).toEqual([]);
  });
});
