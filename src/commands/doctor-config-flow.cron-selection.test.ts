import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../config/io.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import { saveCronStore } from "../cron/store.js";
import { createReloadCronJob } from "../cron/store.test-support.js";
import { createNonExitingRuntime } from "../runtime.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { prepareAutomaticHeartbeatRepair } from "./doctor-automatic-heartbeat-repair.js";
import {
  prepareDoctorContext,
  withDoctorConfigMaintenance,
} from "./doctor-config-flow.test-support.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { createDoctorPrompter } from "./doctor-prompter.js";

async function withMovedHeartbeatState(
  run: (fixture: { configPath: string; original: string; retainedKey: string }) => Promise<void>,
  heartbeat = true,
) {
  await withDoctorConfigPreflightHome((home) =>
    withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
      const configPath = await writeOpenClawConfig(home, {
        agents: {
          ownership: "explicit",
          defaults: heartbeat
            ? { heartbeat: { every: "0m", prompt: "Retained legacy heartbeat" } }
            : {},
          entries: { main: {} },
        },
        gateway: { mode: "local" },
        plugins: { enabled: false },
      });
      const original = await fs.readFile(configPath, "utf8");
      const retainedKey = path.join(home, "previous-state", "cron", "jobs.json");
      await saveCronStore(retainedKey, {
        version: 1,
        jobs: [createReloadCronJob({ id: "retained-job", agentId: "main" })],
      });
      openOpenClawStateDatabase()
        .db.prepare("DELETE FROM config_machine_state WHERE state_key = 'cron.defaultStoreKey'")
        .run();
      await withDoctorConfigMaintenance(() => run({ configPath, original, retainedKey }));
    }),
  );
}

it("selects the retained partition before consuming legacy heartbeat settings", async () => {
  await withMovedHeartbeatState(async ({ configPath, original, retainedKey }) => {
    const options = { repair: true };
    const prompter = {
      ...createDoctorPrompter({ runtime: createNonExitingRuntime(), options }),
      selectRuntimeRepair: vi.fn().mockImplementation(async () => {
        expect(await fs.readFile(configPath, "utf8")).toBe(original);
        return retainedKey;
      }),
    };
    await using ctx = await prepareDoctorContext(configPath, { options, prompter });
    expect(prompter.selectRuntimeRepair).toHaveBeenCalledOnce();
    expect(ctx.configResult.warnings?.join("\n") ?? "").not.toContain(
      "select the cron partition and migrate heartbeat settings",
    );
    const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(saved.agents.defaults.heartbeat).toBeUndefined();
    expect(
      openOpenClawStateDatabase()
        .db.prepare(
          "SELECT value_json FROM config_machine_state WHERE state_key = 'cron.defaultStoreKey'",
        )
        .get(),
    ).toEqual({ value_json: JSON.stringify(retainedKey) });
    expect(
      openOpenClawStateDatabase()
        .db.prepare("SELECT store_key FROM cron_jobs WHERE job_id = 'retained-job'")
        .get(),
    ).toEqual({ store_key: retainedKey });
  });
});

it("admits an automatic update with valid config while cron selection remains unresolved", async () => {
  await withMovedHeartbeatState(async ({ configPath, original }) => {
    await withEnvAsync({ OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1" }, async () => {
      const admission = await prepareAutomaticHeartbeatRepair({ nonInteractive: true });
      expect(admission).toBeDefined();
      const result = await runDoctorConfigPreflight({
        observe: false,
        doctorOnlyStateMigrations: true,
        automaticHeartbeatRepair: admission,
      });
      await result.pluginCache?.[Symbol.asyncDispose]();
      expect(result.cronStoreSelectionUnresolved).toBe(true);
      expect(result.heartbeatMigrationDeferred).toBeUndefined();
      expect(await fs.readFile(configPath, "utf8")).toBe(original);
    });
  }, false);
});

it("keeps unrelated config repairs available while the cron partition is unresolved", async () => {
  await withMovedHeartbeatState(async ({ configPath, original }) => {
    const source = { ...JSON.parse(original), unknownCronRelocationFixtureKey: true };
    await fs.writeFile(configPath, JSON.stringify(source));
    await using ctx = await prepareDoctorContext(configPath, {
      options: { repair: true, yes: true },
    });
    expect(ctx.configResult.shouldWriteConfig).toBe(true);
    expect(ctx.cfg).not.toHaveProperty("unknownCronRelocationFixtureKey");
    expect(
      openOpenClawStateDatabase()
        .db.prepare(
          "SELECT value_json FROM config_machine_state WHERE state_key = 'cron.defaultStoreKey'",
        )
        .get(),
    ).toBeUndefined();
  }, false);
});

it("keeps the original heartbeat config when --fix --yes cannot resolve its partition", async () => {
  await withMovedHeartbeatState(async ({ configPath, original }) => {
    await using ctx = await prepareDoctorContext(configPath, {
      options: { repair: true, yes: true },
    });
    expect(ctx.configResult.shouldWriteConfig).toBe(false);
    expect(await fs.readFile(configPath, "utf8")).toBe(original);
    expect(ctx.configResult.warnings).toContain(
      "Run openclaw doctor --fix interactively to select the cron partition and migrate heartbeat settings. The original config was retained.",
    );
  });
});

it("defers an admitted automatic update heartbeat repair without consuming its source", async () => {
  await withMovedHeartbeatState(async ({ configPath, original }) => {
    const snapshot = await readConfigFileSnapshot();
    const result = await runDoctorConfigPreflight({
      observe: false,
      doctorOnlyStateMigrations: true,
      repairPrefixedConfig: true,
      automaticHeartbeatRepair: { snapshot },
    });
    await result.pluginCache?.[Symbol.asyncDispose]();
    expect(result.heartbeatMigrationDeferred).toBe(true);
    expect(await fs.readFile(configPath, "utf8")).toBe(original);
    expect(result.warnings?.join("\n")).toContain(
      "Run openclaw doctor --fix interactively to select the cron partition and migrate heartbeat settings",
    );
  });
});
