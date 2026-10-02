import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useConfigCliIntegrationHarness } from "./config-cli.integration.test-harness.js";

const { runRegisteredConfigCommand, withConfigFileHarness } = useConfigCliIntegrationHarness();

describe("config CLI file imports", () => {
  // Windows normalizes trailing spaces, so these require distinct POSIX filenames.
  it.skipIf(process.platform === "win32").each([
    { command: "patch", flag: "--file", siblingLevel: "error" },
    { command: "set", flag: "--batch-file", siblingLevel: "warn" },
  ])(
    "config $command $flag reads the exact quoted filename",
    async ({ command, flag, siblingLevel }) => {
      await withConfigFileHarness(
        "openclaw-config-cli-literal-file-",
        '{"gateway":{"mode":"local"},"logging":{"level":"info"}}',
        async ({ configPath, tempDir }) => {
          const file = path.join(tempDir, "import.json5");
          const contents = (level: string) =>
            JSON.stringify(
              command === "patch"
                ? { logging: { level } }
                : [{ path: "logging.level", value: level }],
            );
          fs.writeFileSync(file, contents(siblingLevel));
          fs.writeFileSync(`${file} `, contents("debug"));

          await runRegisteredConfigCommand(["config", command, flag, `${file} `]);

          expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toMatchObject({
            logging: { level: "debug" },
          });
        },
      );
    },
  );
});
