import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { prepareDoctorContext } from "../../commands/doctor-config-flow.test-support.js";
import { withDoctorConfigPreflightHome } from "../../commands/doctor-config-preflight.test-support.js";
import { resetConfigRuntimeState } from "../../config/config.js";
import { writeOpenClawConfig } from "../../config/test-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { ensureCliExecutionBootstrap } from "../command-execution-startup.js";
import { resolveCliStartupPolicy } from "../command-startup-policy.js";
import { testApi } from "./config-guard.js";

afterEach(() => {
  testApi.resetConfigGuardStateForTests();
  resetConfigRuntimeState();
  closeOpenClawStateDatabaseForTest();
});

it.each([
  ["message", "send"],
  ["gateway", "run"],
])("leaves retired state for actual Doctor when bootstrapping %s %s", async (...commandPath) => {
  await withDoctorConfigPreflightHome(async (home) => {
    await withEnvAsync(
      { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_UPDATE_IN_PROGRESS: undefined },
      async () => {
        const configPath = await writeOpenClawConfig(home, {
          gateway: { mode: "local" },
          plugins: { enabled: false },
        });
        const sourcePath = path.join(home, ".openclaw", "settings", "voicewake.json");
        const original = '{"triggers":["test wake phrase"]}\n';
        await fs.mkdir(path.dirname(sourcePath), { recursive: true });
        await fs.writeFile(sourcePath, original);
        const originalConfig = await fs.readFile(configPath, "utf8");
        const { db } = openOpenClawStateDatabase();
        const runtime = {
          log: vi.fn(),
          error: vi.fn(),
          exit: (code: number): never => {
            throw new Error(`unexpected exit ${code}`);
          },
        };
        const bootstrap = () =>
          ensureCliExecutionBootstrap({
            runtime,
            commandPath,
            startupPolicy: resolveCliStartupPolicy({ commandPath, jsonOutputMode: true }),
            loadPlugins: false,
          });
        try {
          await bootstrap();

          expect(await fs.readFile(sourcePath, "utf8")).toBe(original);
          expect(await fs.readFile(configPath, "utf8")).toBe(originalConfig);
          expect(db.prepare("SELECT count(*) AS count FROM migration_runs").get()).toEqual({
            count: 0,
          });
          expect(
            db
              .prepare(
                "SELECT meta_key FROM schema_meta WHERE meta_key IN ('startup-migrations', 'state-migrations')",
              )
              .all(),
          ).toEqual([]);
          expect(
            db
              .prepare(
                "SELECT value_json FROM config_machine_state WHERE state_key = 'voicewake.triggers'",
              )
              .get(),
          ).toBeUndefined();

          await prepareDoctorContext(configPath);
          const { db: repairedDb } = openOpenClawStateDatabase();

          await expect(fs.access(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
          expect(
            repairedDb
              .prepare(
                "SELECT value_json FROM config_machine_state WHERE state_key = 'voicewake.triggers'",
              )
              .get(),
          ).toEqual({ value_json: '["test wake phrase"]' });
          const receipts = repairedDb.prepare("SELECT count(*) AS count FROM migration_runs").get();
          expect(receipts?.count).toBeGreaterThan(0);
          testApi.resetConfigGuardStateForTests();
          await bootstrap();
          expect(repairedDb.prepare("SELECT count(*) AS count FROM migration_runs").get()).toEqual(
            receipts,
          );
        } finally {
          closeOpenClawStateDatabaseForTest();
        }
      },
    );
  });
});
