import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";

describe("doctor config flow", () => {
  // Issue #4654: doctor --fix should preserve ${VAR} env var references
  it("preserves env var references in config values", async () => {
    const originalEnv = process.env.TEST_SECRET_TOKEN;
    process.env.TEST_SECRET_TOKEN = "super-secret-value-12345";

    try {
      await withTempHome(async (home) => {
        const configDir = path.join(home, ".openclaw");
        await fs.mkdir(configDir, { recursive: true });
        // Write config with ${VAR} reference
        await fs.writeFile(
          path.join(configDir, "openclaw.json"),
          JSON.stringify(
            {
              gateway: { auth: { mode: "token", token: "${TEST_SECRET_TOKEN}" } },
              agents: { list: [{ id: "main" }] },
            },
            null,
            2,
          ),
          "utf-8",
        );

        const result = await loadAndMaybeMigrateDoctorConfig({
          options: { nonInteractive: true, repair: true },
          confirm: async () => true,
        });

        // The returned config should preserve the ${VAR} reference, NOT the resolved value
        const gateway = (result.cfg as Record<string, unknown>).gateway as Record<string, unknown>;
        const auth = gateway?.auth as Record<string, unknown>;
        expect(auth?.token).toBe("${TEST_SECRET_TOKEN}");
        // Ensure it's NOT the resolved value
        expect(auth?.token).not.toBe("super-secret-value-12345");
      });
    } finally {
      if (originalEnv === undefined) {
        delete process.env.TEST_SECRET_TOKEN;
      } else {
        process.env.TEST_SECRET_TOKEN = originalEnv;
      }
    }
  });

  it("preserves invalid config for doctor repairs", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify(
          {
            gateway: { auth: { mode: "token", token: 123 } },
            agents: { list: [{ id: "pi" }] },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = await loadAndMaybeMigrateDoctorConfig({
        options: { nonInteractive: true },
        confirm: async () => false,
      });

      expect((result.cfg as Record<string, unknown>).gateway).toEqual({
        auth: { mode: "token", token: 123 },
      });
    });
  });

  it("drops unknown keys on repair", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify(
          {
            bridge: { bind: "auto" },
            gateway: { auth: { mode: "token", token: "ok", extra: true } },
            agents: { list: [{ id: "pi" }] },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = await loadAndMaybeMigrateDoctorConfig({
        options: { nonInteractive: true, repair: true },
        confirm: async () => false,
      });

      const cfg = result.cfg as Record<string, unknown>;
      expect(cfg.bridge).toBeUndefined();
      expect((cfg.gateway as Record<string, unknown>)?.auth).toEqual({
        mode: "token",
        token: "ok",
      });
    });
  });
});
