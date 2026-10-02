import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { useConfigCliIntegrationHarness } from "./config-cli.integration.test-harness.js";

const {
  registeredRuntimeLogs,
  registeredRuntimeErrors,
  runRegisteredConfigCommand,
  withConfigFileHarness,
} = useConfigCliIntegrationHarness();

describe("config cli SecretRef builder schema validation", () => {
  it("rejects an unregistered target in dry-run like a real write", async () => {
    const raw =
      '{"gateway":{"mode":"local"},"secrets":{"providers":{"default":{"source":"env"}}}}\n';
    await withConfigFileHarness(
      "openclaw-config-cli-builder-schema-",
      raw,
      async ({ configPath }) => {
        await withEnvAsync({ OPENCLAW_CONFIG_DRY_RUN_TEST_SECRET: "fixture" }, async () => {
          const command = [
            "config",
            "set",
            "auth-profiles:main:profiles.deepseek.key",
            "--ref-provider",
            "default",
            "--ref-source",
            "env",
            "--ref-id",
            "OPENCLAW_CONFIG_DRY_RUN_TEST_SECRET",
          ];
          await expect(runRegisteredConfigCommand([...command, "--dry-run"])).rejects.toThrow(
            "exit 1",
          );
          expect(registeredRuntimeErrors.join("\n")).toContain(
            'Unrecognized key: "auth-profiles:main:profiles"',
          );
          expect(fs.readFileSync(configPath, "utf8")).toBe(raw);

          registeredRuntimeErrors.length = 0;
          await expect(runRegisteredConfigCommand(command)).rejects.toThrow("exit 1");
          expect(registeredRuntimeErrors.join("\n")).toContain(
            'Unrecognized key: "auth-profiles:main:profiles"',
          );
          expect(fs.readFileSync(configPath, "utf8")).toBe(raw);

          await runRegisteredConfigCommand([
            "config",
            "set",
            "gateway.auth.password",
            "--ref-provider",
            "default",
            "--ref-source",
            "env",
            "--ref-id",
            "OPENCLAW_CONFIG_DRY_RUN_TEST_SECRET",
            "--dry-run",
          ]);
          expect(registeredRuntimeLogs.at(-1)).toContain("Dry run successful");
          expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        });
      },
    );
  });
});
