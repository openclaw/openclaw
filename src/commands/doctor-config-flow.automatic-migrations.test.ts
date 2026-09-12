import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { readConfigFileSnapshot } from "../config/config.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";

afterEach(() => closeOpenClawStateDatabaseForTest());

it("normalizes the retired metadata left by a shipped npm updater without repair flags", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    await withEnvAsync(
      { OPENCLAW_UPDATE_IN_PROGRESS: undefined, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
      async () => {
        const configPath = await writeOpenClawConfig(home, {
          meta: { lastTouchedVersion: "2026.3.31", lastTouchedAt: "2026-03-31T00:00:00.000Z" },
          gateway: { mode: "local", port: 19092 },
          plugins: { enabled: false },
        });
        const original = await fs.readFile(configPath, "utf8");
        expect((await readConfigFileSnapshot()).valid).toBe(false);

        // v2026.3.31's npm updater passes only this flag, with no update environment marker.
        const ctx = await prepareDoctorContext(configPath, { options: { nonInteractive: true } });

        expect(ctx.prompter.shouldRepair).toBe(false);
        const saved = await readConfigFileSnapshot();
        expect(saved.valid).toBe(true);
        expect(saved.sourceConfig).not.toHaveProperty("meta.lastTouchedAt");
        expect(saved.sourceConfig.gateway).toEqual({ mode: "local", port: 19092 });
        expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(original);
      },
    );
  });
});

it.each([
  { name: "an include", include: true },
  { name: "a remaining invalid key", invalid: true },
  { name: "a future writer", future: true },
  { name: "externally managed config", env: { OPENCLAW_CONFIG_READONLY: "1" } },
  { name: "Nix-managed config", env: { OPENCLAW_NIX_MODE: "1" } },
  { name: "deferred plugin validation", env: { OPENCLAW_UPDATE_IN_PROGRESS: "1" } },
])("preserves config bytes with $name during ordinary Doctor", async (fixture) => {
  await withDoctorConfigPreflightHome(async (home) => {
    await withEnvAsync(
      {
        OPENCLAW_UPDATE_IN_PROGRESS: undefined,
        OPENCLAW_CONFIG_READONLY: undefined,
        OPENCLAW_NIX_MODE: undefined,
        OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        ...fixture.env,
      },
      async () => {
        const configPath = await writeOpenClawConfig(home, {
          meta: {
            lastTouchedAt: "2026-03-31T00:00:00.000Z",
            lastTouchedVersion: fixture.future ? "9999.1.1" : "2026.3.31",
            ...(fixture.invalid ? { unknownSetting: true } : {}),
          },
          gateway: fixture.include ? { $include: "gateway.json" } : { mode: "local" },
          plugins: { enabled: false },
        });
        if (fixture.include) {
          await fs.writeFile(
            path.join(path.dirname(configPath), "gateway.json"),
            '{"mode":"local"}',
          );
        }
        const original = await fs.readFile(configPath, "utf8");

        await prepareDoctorContext(configPath, { options: { nonInteractive: true } });

        expect(await fs.readFile(configPath, "utf8")).toBe(original);
        await expect(fs.access(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
      },
    );
  });
});
