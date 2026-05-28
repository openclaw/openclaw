import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CronJob } from "../types.js";
import { runCronCommandJob, type CronCommandPayload } from "./command-payload.js";

const tempDirs: string[] = [];

async function makeRepoRoot(packageJson: Record<string, unknown>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-command-"));
  tempDirs.push(dir);
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(packageJson), "utf8");
  await fs.writeFile(path.join(dir, "pnpm-workspace.yaml"), "packages: []\n", "utf8");
  await fs.writeFile(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  return dir;
}

function makeCommandJob(payload: CronCommandPayload): CronJob & { payload: CronCommandPayload } {
  return {
    id: "command-job",
    name: "command job",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload,
    state: {},
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("runCronCommandJob", () => {
  it("rejects command payloads that are not declared package scripts", async () => {
    const workspaceRoot = await makeRepoRoot({ scripts: { check: 'node -e "process.exit(0)"' } });
    const job = makeCommandJob({ kind: "command", script: "cron:direct:run" });

    const result = await runCronCommandJob({
      job,
      payload: job.payload,
      workspaceRoot,
      storePath: path.join(workspaceRoot, ".openclaw", "cron", "jobs.json"),
      nowMs: () => 123,
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("script is not declared in package.json");
  });

  it("rejects command payloads with shell-shaped script names", async () => {
    const workspaceRoot = await makeRepoRoot({ scripts: { "cron:direct:run": "node -v" } });
    const job = makeCommandJob({ kind: "command", script: "cron:direct:run && npm install" });

    const result = await runCronCommandJob({
      job,
      payload: job.payload,
      workspaceRoot,
      storePath: path.join(workspaceRoot, ".openclaw", "cron", "jobs.json"),
      nowMs: () => 123,
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("invalid package script name");
  });
});
