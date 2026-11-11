import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { readConfigFileSnapshot, writeConfigFile } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runInitialConfigWriteHealth } from "../flows/doctor-health-contribution-runners.config.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { VERSION } from "../version.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import { useDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { externalDoctorEnv } from "./doctor-update.test-support.js";

const withHome = useDoctorConfigPreflightHome();

it("preserves the released updater's bookkeeping comparison during candidate Doctor", async () => {
  await withHome(async (home) => {
    const configPath = path.join(home, "openclaw.json");
    const original: OpenClawConfig = {
      meta: { lastTouchedVersion: "2026.9.4", migrations: { modelPolicyAllowlist: true } },
      wizard: {
        lastRunAt: "2026-09-10T12:00:00.000Z",
        lastRunVersion: "2026.9.4",
        lastRunCommand: "doctor",
        lastRunMode: "local",
      },
      agents: {
        defaults: { model: "openai/gpt-5.6-sol", workspace: path.join(home, "workspace") },
        entries: { main: {} },
      },
      gateway: { mode: "local", bind: "loopback" },
      plugins: { enabled: false },
    };
    await fs.writeFile(configPath, JSON.stringify(original));
    await withEnvAsync(
      {
        ...buildUpdateRehearsalPathEnv(home),
        ...externalDoctorEnv(),
        OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
      async () => {
        await using ctx = await prepareDoctorContext(configPath);
        // Exercise the write stage without loading optional plugin repairs.
        ctx.configResult.shouldWriteConfig = true;
        await runInitialConfigWriteHealth(ctx);
        expect(ctx.configWriteRefusal).toBeUndefined();
        // Other rehearsal commands can also write config without Doctor's wizard stage.
        await writeConfigFile(ctx.cfg);
        const saved = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
        for (const key of ["meta", "wizard", "plugins"] as const) {
          expect.soft(saved[key], key).toEqual(original[key]);
        }
        expect((await readConfigFileSnapshot()).valid).toBe(true);

        // Activation leaves the disposable-pass contract. The next real write
        // must still materialize legacy model restrictions and version metadata.
        await withEnvAsync({ OPENCLAW_UPDATE_IN_PROGRESS: undefined }, async () => {
          const activated: OpenClawConfig = {
            ...original,
            meta: { lastTouchedVersion: "2026.9.4" },
            agents: {
              ...original.agents,
              defaults: {
                ...original.agents?.defaults,
                models: { "openai/gpt-5.6-sol": {} },
              },
            },
          };
          await fs.writeFile(configPath, JSON.stringify(activated));
          await writeConfigFile(activated);
          const after = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
          expect(after.agents?.defaults?.modelPolicy?.allow).toEqual(["openai/gpt-5.6-sol"]);
          expect(after.meta).toMatchObject({
            lastTouchedVersion: VERSION,
            migrations: { modelPolicyAllowlist: true, utilityModelSeparation: true },
          });
        });
      },
    );
  });
});
