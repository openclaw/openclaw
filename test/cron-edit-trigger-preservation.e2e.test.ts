import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { CronJob } from "../src/cron/types.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

it(
  "cron edit validates locally and preserves trigger.once across Gateway restart",
  { timeout: 180_000 },
  async ({ onTestFinished }) => {
    const instance = await createOpenClawTestInstance({
      name: "cron-edit-trigger-preservation",
      config: { cron: { enabled: true, triggers: { enabled: true } } },
      env: { OPENCLAW_SKIP_CRON: "0" },
    });
    onTestFinished(() => instance.cleanup());
    const cron = (...args: string[]) => instance.cli(["cron", ...args]);
    const cronJson = async <T = unknown>(...args: string[]): Promise<T> => {
      const result = await cron(...args);
      expect(result.code, result.stderr).toBe(0);
      return JSON.parse(result.stdout) as T;
    };
    const initialScriptPath = path.join(instance.homeDir, "initial-trigger.js");
    const replacementScriptPath = path.join(instance.homeDir, "replacement-trigger.js");
    const oversizedScriptPath = path.join(instance.homeDir, "oversized-trigger.js");
    await Promise.all([
      fs.writeFile(initialScriptPath, "return { fire: false };", "utf8"),
      fs.writeFile(replacementScriptPath, "return { fire: true };", "utf8"),
      fs.writeFile(oversizedScriptPath, "x".repeat(65_537), "utf8"),
    ]);

    const invalid = await cron("edit", "not-yet-created", "--trigger-script", oversizedScriptPath);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("Trigger script exceeds 65536 bytes");
    expect(invalid.stderr).not.toContain("ECONNREFUSED");

    await instance.startGateway();
    expect(await cronJson("status", "--json")).toMatchObject({
      enabled: true,
      storage: "sqlite",
      sqlitePath: path.join(instance.stateDir, "state", "openclaw.sqlite"),
    });

    const addedJob: CronJob = await cronJson(
      "add",
      "trigger-preservation",
      "--every",
      "1h",
      "--system-event",
      "check trigger",
      "--session",
      "main",
      "--trigger-script",
      initialScriptPath,
      "--trigger-once",
      "--json",
    );

    const edited = await cron("edit", addedJob.id, "--trigger-script", replacementScriptPath);
    expect(edited.code, edited.stderr).toBe(0);

    await instance.stopGateway();
    await instance.startGateway();
    expect((await cronJson<CronJob>("get", addedJob.id, "--json")).trigger).toEqual({
      script: "return { fire: true };",
      once: true,
    });
  },
);
