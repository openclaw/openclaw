import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  consumeGatewayBootstrapSteps,
  createGatewayDispatchStartupTrace,
} from "../cli/startup-trace.js";
import { resetConfigRuntimeState } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { recordStartupMigrationWarnings } from "../infra/state-migrations.messages.js";
import { withTempHomeCore } from "../plugin-sdk/test-helpers/temp-home.js";
import { setActiveDegradedPlugins } from "../plugins/runtime-degraded-state.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withEnvAsync } from "../test-utils/env.js";
import { recordUnwrittenWebhookCompletion } from "./doctor/shared/legacy-webhook-pins.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

afterEach(async () => {
  consumeGatewayBootstrapSteps();
  setActiveDegradedPlugins([]);
  recordStartupMigrationWarnings([]);
  await closeStateDatabaseForTest();
  resetConfigRuntimeState();
});

it.each<{
  name: string;
  marker: true | Record<string, string[][]>;
  configMarker?: Record<string, string[][]>;
  runsMigration: boolean;
}>([
  { name: "all listeners", marker: true as const, runsMigration: false },
  {
    name: "each historical channel",
    marker: { telegram: [], feishu: [], msteams: [], "nextcloud-talk": [] },
    runsMigration: false,
  },
  { name: "incomplete receipt", marker: { telegram: [] }, runsMigration: true },
  {
    name: "explicit incomplete config overriding a complete receipt",
    marker: true as const,
    configMarker: { telegram: [] },
    runsMigration: true,
  },
])(
  "honors persisted webhook readiness for $name",
  async ({ marker, configMarker, runsMigration }) => {
    await withTempHomeCore(
      async (home) => {
        await withEnvAsync(
          { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_GATEWAY_STARTUP_TRACE: "1" },
          async () => {
            const configPath = path.join(home, ".openclaw", "openclaw.json");
            const config: OpenClawConfig = {
              gateway: { mode: "local" },
              plugins: { enabled: false },
              ...(configMarker ? { meta: { migrations: { webhookListeners: configMarker } } } : {}),
            };
            const bytes = `${JSON.stringify(config)}\n`;
            await fs.writeFile(configPath, bytes);
            expect(
              recordUnwrittenWebhookCompletion(
                { sourceConfig: config },
                {
                  config: { ...config, meta: { migrations: { webhookListeners: marker } } },
                  changes: ["Recorded webhook listener decisions"],
                },
                process.env,
              ),
            ).toBe(true);
            await closeStateDatabaseForTest();
            createGatewayDispatchStartupTrace(["node", "openclaw", "gateway", "run"], "entry");

            const ready = await runStartupConfigPreflight({ gateway: true, observe: false });

            expect(ready.snapshot.valid).toBe(true);
            expect(await fs.readFile(configPath, "utf8")).toBe(bytes);
            expect(
              consumeGatewayBootstrapSteps().some(
                (step) => step.name === "cli.bootstrap.webhook-readiness",
              ),
            ).toBe(runsMigration);
          },
        );
      },
      { env: { OPENCLAW_CONFIG_PATH: undefined } },
    );
  },
);
