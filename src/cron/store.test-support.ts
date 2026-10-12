import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect } from "vitest";
import type { CronStoreFile } from "./types.js";

type FixtureStore = { version: 1; jobs: [CronStoreFile["jobs"][number]] };

export function makeStore(jobId: string, enabled: boolean): FixtureStore {
  const now = Date.now();
  return {
    version: 1,
    jobs: [
      {
        id: jobId,
        name: `Job ${jobId}`,
        enabled,
        createdAtMs: now,
        updatedAtMs: now,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: `tick-${jobId}` },
        state: {},
      },
    ],
  };
}

export function createStorePathFixture() {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-store-"));
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  return async function makeStorePath() {
    const dir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(dir, { recursive: true });
    return {
      storePath: path.join(dir, "cron", "jobs.json"),
    };
  };
}

export async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}
