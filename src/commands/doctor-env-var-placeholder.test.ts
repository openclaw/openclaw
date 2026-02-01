import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { withTempHome } from "../../test/helpers/temp-home.js";
import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";
import { readConfigFileSnapshot, writeConfigFile } from "../config/config.js";

describe("doctor env var placeholder preservation", () => {
  it("preserves env var placeholders when applying repairs", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify(
          {
            gateway: { auth: { mode: "token", token: "${TEST_SECRET_TOKEN_1}" } },
            agents: { list: [{ id: "pi" }] },
            env: {
              TEST_SECRET_TOKEN_1: "secret-token-123",
            },
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

      // The result config should have the resolved value for runtime use
      expect(result.cfg.gateway?.auth?.token).toBe("secret-token-123");

      // When we write it back using the template, it should preserve the placeholder
      await writeConfigFile(result.cfg, result.template);

      const snapshot = await readConfigFileSnapshot();
      expect(snapshot.template.gateway?.auth?.token).toBe("${TEST_SECRET_TOKEN_1}");
    });
  });

  it("handles mixed config with some resolved values and some placeholders", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify(
          {
            gateway: {
              auth: {
                mode: "token",
                token: "${TEST_SECRET_TOKEN_2}",
              },
            },
            agents: {
              list: [{ id: "pi" }],
            },
            env: {
              TEST_SECRET_TOKEN_2: "secret-token-456",
            },
            // This is an invalid field that doctor should remove
            invalidField: "should be removed",
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

      // The result config should have the resolved value for runtime use
      expect(result.cfg.gateway?.auth?.token).toBe("secret-token-456");
      // Invalid field should be removed from runtime config
      expect((result.cfg as Record<string, unknown>)["invalidField"]).toBeUndefined();

      // Write it back
      await writeConfigFile(result.cfg, result.template);

      const snapshot = await readConfigFileSnapshot();
      expect(snapshot.template.gateway?.auth?.token).toBe("${TEST_SECRET_TOKEN_2}");
      expect((snapshot.template as Record<string, unknown>)["invalidField"]).toBeUndefined();
    });
  });
});
