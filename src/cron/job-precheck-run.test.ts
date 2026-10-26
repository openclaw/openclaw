import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetProcessRegistryForTests } from "../agents/bash-process-registry.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { saveExecApprovals } from "../infra/exec-approvals-store.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { runCronJobPrecheck } from "./job-precheck-run.js";
import type { CronStoredJob } from "./types.js";

function execConfig(security: "deny" | "full", ask: "off" | "always"): OpenClawConfig {
  return {
    tools: {
      exec: { host: "gateway", security, ask, mode: "full" },
    },
  };
}

function writePolicy(security: "deny" | "full", ask: "off" | "always") {
  saveExecApprovals({ version: 1, defaults: { security, ask }, agents: {} });
}

function nodeCommand(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

function markerCommand(marker: string, exitCode: number): string {
  const script = `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran"); process.exit(${exitCode})`;
  return nodeCommand(script);
}

function precheckJob(command: string, extra: Partial<CronStoredJob> = {}): CronStoredJob {
  return {
    ...makeCronJob({
      agentId: "main",
      payload: { kind: "agentTurn", message: "Process new mail", toolsAllow: ["*"] },
      precheck: {
        command,
        timeoutSeconds: 30,
        workExitCodes: [0],
        noWorkExitCodes: [2],
      },
    }),
    ...extra,
  };
}

let envSnapshot: ReturnType<typeof captureEnv>;
let tempRoot: string;

beforeEach(() => {
  envSnapshot = captureEnv(["HOME", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cron-precheck-"));
  setTestEnvValue("HOME", tempRoot);
  setTestEnvValue("OPENCLAW_HOME", tempRoot);
  setTestEnvValue("OPENCLAW_STATE_DIR", path.join(tempRoot, "state"));
  fs.mkdirSync(path.join(tempRoot, "state"), { recursive: true });
  resetProcessRegistryForTests();
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  envSnapshot.restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("runCronJobPrecheck exec policy", () => {
  it("does not spawn when security is deny", async () => {
    writePolicy("deny", "off");
    const marker = path.join(tempRoot, "deny");
    const result = await runCronJobPrecheck({
      job: precheckJob(markerCommand(marker, 0)),
      config: execConfig("deny", "off"),
    });

    expect(result).toMatchObject({
      kind: "denied",
      error: expect.stringContaining("exec denied:"),
    });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("does not spawn when ask is always", async () => {
    writePolicy("full", "always");
    const marker = path.join(tempRoot, "ask");
    const result = await runCronJobPrecheck({
      job: precheckJob(markerCommand(marker, 0)),
      config: execConfig("full", "always"),
    });

    expect(result).toMatchObject({ kind: "denied" });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("does not spawn when the job pin requires ask always", async () => {
    writePolicy("full", "off");
    const marker = path.join(tempRoot, "pin");
    const result = await runCronJobPrecheck({
      job: precheckJob(markerCommand(marker, 0), {
        toolsAllowExecTarget: { version: 1, host: "gateway", ask: "always" },
      }),
      config: execConfig("full", "off"),
    });

    expect(result).toMatchObject({ kind: "denied" });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("does not spawn when toolsAllow excludes exec", async () => {
    writePolicy("full", "off");
    const marker = path.join(tempRoot, "tools");
    const job = precheckJob(markerCommand(marker, 0));
    job.payload = { kind: "agentTurn", message: "Process new mail", toolsAllow: ["read"] };
    const result = await runCronJobPrecheck({
      job,
      config: execConfig("full", "off"),
    });

    expect(result).toEqual({
      kind: "denied",
      error: "exec denied: cron toolsAllow does not include exec",
    });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("does not spawn when run authority is rejected", async () => {
    writePolicy("full", "off");
    const marker = path.join(tempRoot, "stale");
    await expect(
      runCronJobPrecheck({
        job: precheckJob(markerCommand(marker, 0)),
        config: execConfig("full", "off"),
        assertRunCurrent: () => {
          throw new Error("stale run");
        },
      }),
    ).rejects.toThrow("stale run");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("classifies an allowed exit 2 as no work and exit 0 as work", async () => {
    writePolicy("full", "off");
    const quiet = path.join(tempRoot, "quiet");
    const busy = path.join(tempRoot, "busy");
    const config = execConfig("full", "off");

    await expect(
      runCronJobPrecheck({ job: precheckJob(markerCommand(quiet, 2)), config }),
    ).resolves.toEqual({ kind: "no-work", exitCode: 2 });
    await expect(
      runCronJobPrecheck({ job: precheckJob(markerCommand(busy, 0)), config }),
    ).resolves.toEqual({ kind: "work", exitCode: 0 });
    expect(fs.readFileSync(quiet, "utf8")).toBe("ran");
    expect(fs.readFileSync(busy, "utf8")).toBe("ran");
  });
});
