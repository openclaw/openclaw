import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { loadCronStore } from "../../../cron/store.js";
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

async function writeLegacyCronStore(storePath: string) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(
    storePath,
    JSON.stringify({
      version: 1,
      jobs: [
        {
          jobId: "legacy-job",
          name: "Legacy job",
          notify: true,
          createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
          updatedAtMs: Date.parse("2026-02-02T00:00:00.000Z"),
          schedule: { kind: "cron", cron: "0 7 * * *", tz: "UTC" },
          payload: { kind: "systemEvent", text: "Morning brief" },
          state: {},
        },
      ],
    }),
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
  it("imports legacy cron jobs into SQLite and archives the legacy store", async () => {
    const storePath = await makeTempStorePath();
    await writeLegacyCronStore(storePath);

    const result = await autoMigrateLegacyCronStore({ cfg: createCronConfig(storePath) });

    const [job] = (await loadCronStore(storePath)).jobs as unknown as Array<
      Record<string, unknown>
    >;
    expect(job?.id).toBe("legacy-job");
    expect(job?.jobId).toBeUndefined();
    expect(requireRecord(job?.delivery, "cron delivery").mode).toBe("webhook");
    await expect(fs.stat(`${storePath}.migrated`)).resolves.toBeTruthy();
    expect(result.changes.join("\n")).toContain("Cron store migrated to SQLite");
    expect(result.warnings).toEqual([]);
  });
});
