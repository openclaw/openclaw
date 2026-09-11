import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import {
  runInitialConfigWriteHealth,
  runWriteConfigHealth,
} from "../flows/doctor-health-contribution-runners.config.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { setTestEnvValue, withEnvAsync } from "../test-utils/env.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";

const noteMock = vi.hoisted(() => vi.fn<(message: string, title?: string) => void>());

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: noteMock,
}));

function createRepairableConfig(home: string) {
  return {
    agents: { entries: { main: { workspace: path.join(home, "workspace") } } },
    browser: { enabled: false, actionTimeoutMs: 5000 },
    gateway: { mode: "local" },
    logging: { level: "info", file: path.join(home, "doctor.log") },
    plugins: { enabled: false },
  };
}

function expectConflictWarning() {
  const warnings = noteMock.mock.calls
    .filter(([, title]) => title === "Doctor warnings")
    .map(([message]) => message)
    .join("\n");
  expect(warnings).toContain("changed");
  expect(warnings).toContain("These config fixes were not written.");
  expect(warnings).toMatch(/rerun "openclaw doctor"/i);
  expect(noteMock.mock.calls.some(([, title]) => title === "Doctor changes")).toBe(false);
}

describe("Doctor repair confirmation conflicts", () => {
  afterEach(() => {
    noteMock.mockClear();
    closeOpenClawStateDatabaseForTest();
  });

  it.each([
    { scenario: "accepting repairs after an edit", saveEdit: true, accept: true },
    { scenario: "accepting repairs without an edit", saveEdit: false, accept: true },
    { scenario: "declining repairs after an edit", saveEdit: true, accept: false },
  ])("preserves saved settings when $scenario", async ({ saveEdit, accept }) => {
    await withDoctorConfigPreflightHome(async (home) => {
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const config = createRepairableConfig(home);
        const configPath = await writeOpenClawConfig(home, config);
        const original = await fs.readFile(configPath, "utf8");
        const edited = JSON.stringify(
          { ...config, logging: { ...config.logging, level: "debug" } },
          null,
          2,
        );
        let confirmationShown = false;
        const ctx = await prepareDoctorContext(configPath, {
          options: {},
          confirm: async ({ message }) => {
            expect(message).toBe("Apply recommended config repairs now?");
            confirmationShown = true;
            if (saveEdit) {
              await fs.writeFile(configPath, edited);
            }
            return accept;
          },
        });
        expect(confirmationShown).toBe(true);

        await expect(runInitialConfigWriteHealth(ctx)).resolves.toBeUndefined();

        if (saveEdit) {
          // The final writer must not revive a declined or refused candidate.
          await runWriteConfigHealth(ctx);
          await expect(fs.readFile(configPath, "utf8")).resolves.toBe(edited);
          await expect(fs.access(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
          expect(ctx.configResultWriteCommitted).not.toBe(true);
          if (accept) {
            expectConflictWarning();
          }
          return;
        }

        const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
        expect(saved.browser).toEqual({ enabled: false });
        expect(saved.logging.level).toBe("info");
        await expect(fs.readFile(`${configPath}.bak`, "utf8")).resolves.toBe(original);
        expect(ctx.configResultWriteCommitted).toBe(true);

        // A later health repair is based on the committed candidate, so the
        // confirmation's original source must no longer block that write.
        ctx.cfg = { ...ctx.cfg, gateway: { ...ctx.cfg.gateway, bind: "lan" } };
        await runWriteConfigHealth(ctx);
        const afterHealthRepair = JSON.parse(await fs.readFile(configPath, "utf8"));
        expect(afterHealthRepair.gateway.bind).toBe("lan");
        expect(afterHealthRepair.browser).toEqual({ enabled: false });
        expect(afterHealthRepair.logging.level).toBe("info");
      });
    });
  });

  it("refuses a config path switch during confirmation even when both files have identical bytes", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const configPath = await writeOpenClawConfig(home, createRepairableConfig(home));
        const original = await fs.readFile(configPath, "utf8");
        const otherPath = path.join(path.dirname(configPath), "other.json");
        await fs.writeFile(otherPath, original);

        await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath }, async () => {
          let confirmationShown = false;
          const ctx = await prepareDoctorContext(configPath, {
            options: {},
            confirm: async ({ message }) => {
              expect(message).toBe("Apply recommended config repairs now?");
              confirmationShown = true;
              setTestEnvValue("OPENCLAW_CONFIG_PATH", otherPath);
              return true;
            },
          });
          expect(confirmationShown).toBe(true);

          await expect(runInitialConfigWriteHealth(ctx)).resolves.toBeUndefined();
          await runWriteConfigHealth(ctx);

          for (const file of [configPath, otherPath]) {
            await expect(fs.readFile(file, "utf8")).resolves.toBe(original);
            await expect(fs.access(`${file}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
          }
          expect(ctx.configResultWriteCommitted).not.toBe(true);
          expectConflictWarning();
        });
      });
    });
  });
});
