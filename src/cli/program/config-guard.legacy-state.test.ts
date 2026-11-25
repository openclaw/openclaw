import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { prepareDoctorContext } from "../../commands/doctor-config-flow.test-support.js";
import { withDoctorConfigPreflightHome } from "../../commands/doctor-config-preflight.test-support.js";
import { writeOpenClawConfig } from "../../config/test-helpers.js";
import { readStartupMigrationWarning } from "../../infra/state-migrations.messages.js";
import * as stateDb from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { ensureCliExecutionBootstrap } from "../command-execution-startup.js";
import { resolveCliStartupPolicy } from "../command-startup-policy.js";
import { ensureConfigReady, testApi } from "./config-guard.js";

afterEach(() => testApi.resetConfigGuardStateForTests());

it.each(["message send", "gateway run"])(
  "leaves retired state for Doctor after %s",
  async (command) => {
    const commandPath = command.split(" ");
    await withDoctorConfigPreflightHome(async (home) => {
      await withEnvAsync(
        { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_UPDATE_IN_PROGRESS: undefined },
        async () => {
          const configPath = await writeOpenClawConfig(home, {
            meta: { migrations: { webhookListeners: true } },
            gateway: { mode: "local" },
            plugins: { enabled: false },
          });
          const sourcePath = path.join(home, ".openclaw", "settings", "voicewake.json");
          const original = '{"triggers":["test wake phrase"]}\n';
          await fs.mkdir(path.dirname(sourcePath), { recursive: true });
          await fs.writeFile(sourcePath, original);
          const originalConfig = await fs.readFile(configPath, "utf8");
          stateDb.openOpenClawStateDatabase();
          const expectUnchanged = async () => {
            const { db } = stateDb.openOpenClawStateDatabase();
            expect(await fs.readFile(sourcePath, "utf8")).toBe(original);
            expect(await fs.readFile(configPath, "utf8")).toBe(originalConfig);
            expect(db.prepare("SELECT count(*) AS count FROM migration_runs").get()).toEqual({
              count: 0,
            });
            const markers =
              "SELECT meta_key FROM schema_meta WHERE meta_key IN ('startup-migrations', 'state-migrations')";
            expect(db.prepare(markers).all()).toEqual([]);
            const voicewake =
              "SELECT value_json FROM config_machine_state WHERE state_key = 'voicewake.triggers'";
            expect(db.prepare(voicewake).get()).toBeUndefined();
          };
          const runtime = {
            log: vi.fn(),
            error: vi.fn(),
            exit: (code: number): never => {
              throw new Error(`unexpected exit ${code}`);
            },
          };
          const bootstrap = async () => {
            await ensureCliExecutionBootstrap({
              runtime,
              commandPath,
              startupPolicy: resolveCliStartupPolicy({ commandPath, jsonOutputMode: true }),
              loadPlugins: false,
            });
            if (commandPath[0] === "message") {
              // Message actions own local preparation after the outer bootstrap defers it.
              await ensureConfigReady({ runtime, commandPath, suppressDoctorStdout: true });
            }
          };
          try {
            await bootstrap();

            expect(readStartupMigrationWarning()).toContain(
              "Retired runtime state was left unchanged for Doctor; no import was attempted.",
            );
            expect(readStartupMigrationWarning()).toContain(sourcePath);
            await expectUnchanged();

            await using doctor = await prepareDoctorContext(configPath, {
              options: { nonInteractive: true, repair: false },
            });
            expect(doctor.sourceConfigValid).toBe(true);
            await expectUnchanged();
            testApi.resetConfigGuardStateForTests();
            await bootstrap();
            await expectUnchanged();
          } finally {
            stateDb.closeOpenClawStateDatabaseForTest();
          }
        },
      );
    });
  },
);
