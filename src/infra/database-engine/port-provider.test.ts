import { fileURLToPath } from "node:url";
import { getEnvironmentData } from "node:worker_threads";
import { describe, expect } from "vitest";
import { createCommandTest } from "../../../test/helpers/command-fixture.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const it = createCommandTest();

describe.skipIf(!connection)("generic database family provider", () => {
  it("ports and restores a second family's fragments, triggers and rebuilt projections", async ({
    command,
  }) => {
    const loader = new URL("./port-provider-loader.test-support.ts", import.meta.url).href;
    const script = new URL("./port-provider-roundtrip.test-support.ts", import.meta.url);
    command.enableDiagnostics("database family provider");
    const result = await command.run(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), fileURLToPath(script)],
      {
        env: {
          ...process.env,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${loader}`,
        },
        input: JSON.stringify({ connection, directory: command.createTempDir("port-provider-") }),
      },
    );
    const output = `${result.stdout}\n${result.stderr}`.replaceAll(
      connection!,
      "[database connection]",
    );
    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(0);
    expect(output).toContain("synthetic family verified");
  }, 60_000);
});
