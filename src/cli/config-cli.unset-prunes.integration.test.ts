import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { useConfigCliIntegrationHarness } from "./config-cli.integration.test-harness.js";

const { runRegisteredConfigCommand: invoke, withConfigFileHarness: withFile } =
  useConfigCliIntegrationHarness();

const read = (file: string) => fs.readFileSync(file, "utf8");

function parsedConfig(raw: string): Record<string, unknown> {
  return JSON.parse(raw) as Record<string, unknown>;
}

function expectPathAbsent(config: Record<string, unknown>, path: readonly string[]): void {
  let cursor: unknown = config;
  for (const segment of path) {
    if (!cursor || typeof cursor !== "object" || !(segment in cursor)) {
      return;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  throw new Error(`expected config path to be pruned: ${path.join(".")}`);
}

describe("config unset prunes emptied parents", () => {
  it("removes an object parent emptied by the unset", async () => {
    await withFile(
      "config-cli-unset-",
      JSON.stringify({ logging: { level: "debug" }, tools: { allow: ["a", "b"] } }) + "\n",
      async ({ configPath }) => {
        await invoke(["config", "unset", "logging.level"]);

        const written = parsedConfig(read(configPath));
        expectPathAbsent(written, ["logging"]);
        expect(written.tools).toEqual({ allow: ["a", "b"] });
      },
    );
  });

  it("splices an object element emptied inside an array", async () => {
    await withFile(
      "config-cli-unset-",
      JSON.stringify({
        plugins: { entries: { example: { config: { values: [{ value: "a" }, { value: "b" }] } } } },
      }) + "\n",
      async ({ configPath }) => {
        await invoke(["config", "unset", "plugins.entries.example.config.values.0.value"]);

        const written = parsedConfig(read(configPath));
        expect(written.plugins).toEqual({
          entries: { example: { config: { values: [{ value: "b" }] } } },
        });
      },
    );
  });

  it("preserves an emptied array", async () => {
    await withFile(
      "config-cli-unset-",
      JSON.stringify({ tools: { allow: ["a"] } }) + "\n",
      async ({ configPath }) => {
        await invoke(["config", "unset", "tools.allow.0"]);

        const written = parsedConfig(read(configPath));
        expect(written.tools).toEqual({ allow: [] });
      },
    );
  });
});
