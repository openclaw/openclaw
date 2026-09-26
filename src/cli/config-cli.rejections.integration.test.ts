import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { describe, expect, it, vi } from "vitest";
import {
  ConfigWritePostCommitError,
  createConfigValidationFailedError,
} from "../config/io.write-errors.js";
import { useConfigCliIntegrationHarness } from "./config-cli.integration.test-harness.js";

const configRuntime = await import("../config/config.js");
const {
  registeredRuntimeLogs,
  registeredRuntimeErrors,
  runRegisteredConfigCommand,
  withConfigFileHarness,
} = useConfigCliIntegrationHarness();

describe("config CLI rejections", () => {
  it("explains rejected settings without saving and accepts their correction", async () => {
    const setting = "channels.discord.guilds.123456789012345678.requireMention";
    const raw =
      '{"channels":{"discord":{"guilds":{"123456789012345678":{"requireMention":true}}}}}\n';
    await withConfigFileHarness(
      "openclaw-config-cli-refusal-",
      raw,
      async ({ configPath, tempDir }) => {
        const patchPath = path.join(tempDir, "patch.json");
        fs.writeFileSync(
          patchPath,
          '{"channels":{"discord":{"guilds":{"123456789012345678":{"requireMention":42}}}}}',
        );
        for (const [args, issue] of [
          [["set", setting, "oops"], "requireMention"],
          [["set", "gateway.nonexistentSetting", "true"], "nonexistentSetting"],
          [["patch", "--file", patchPath], "requireMention"],
        ] as const) {
          registeredRuntimeErrors.length = 0;
          await expect(runRegisteredConfigCommand(["config", ...args])).rejects.toMatchObject({
            name: "ExitError",
            code: 1,
          });
          const output = registeredRuntimeErrors.join("\n");
          expect(output).toContain("Config change declined. No settings were saved.");
          expect(output).toContain(issue);
          expect(output).toContain("Correct the setting above and retry.");
          expect(output).toContain("openclaw config schema");
          expect(output).not.toMatch(/Stack:|Debug:|CLI failed|\bat .*\.ts:\d/);
          expect(registeredRuntimeLogs).toEqual([]);
          expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
          expect(fs.existsSync(`${configPath}.bak`)).toBe(false);
        }
        registeredRuntimeErrors.length = 0;
        await runRegisteredConfigCommand(["config", "set", setting, "false"]);
        expect(
          JSON5.parse(fs.readFileSync(configPath, "utf8")).channels.discord.guilds[
            "123456789012345678"
          ].requireMention,
        ).toBe(false);
        expect(registeredRuntimeErrors).toEqual([]);
        expect(registeredRuntimeLogs.join("\n")).toContain("Updated");
      },
    );
  });

  it.each([
    new Error("Config validation failed: unexpected write failure"),
    new ConfigWritePostCommitError({
      configPath: "/tmp/openclaw.json",
      rollbackStatus: "unknown",
      cause: createConfigValidationFailedError([
        { path: "gateway.port", message: "late validation failure" },
      ]),
    }),
  ])("does not relabel operational failures as unsaved settings: %s", async (error) => {
    await withConfigFileHarness("openclaw-config-cli-operational-", "{}", async () => {
      vi.spyOn(configRuntime, "replaceConfigFile").mockRejectedValueOnce(error);
      await expect(
        runRegisteredConfigCommand(["config", "set", "gateway.port", "19000"]),
      ).rejects.toMatchObject({ name: "ExitError", code: 1 });
      const output = registeredRuntimeErrors.join("\n");
      expect(output).toContain(error.message);
      expect(output).not.toContain("No settings were saved");
      expect(output).not.toContain("Correct the setting above");
      expect(registeredRuntimeLogs).toEqual([]);
    });
  });
});
