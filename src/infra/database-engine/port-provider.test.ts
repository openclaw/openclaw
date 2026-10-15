import { fileURLToPath } from "node:url";
import { getEnvironmentData } from "node:worker_threads";
import { describe, expect } from "vitest";
import { createCommandTest } from "../../../test/helpers/command-fixture.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { admitDatabasePortDescriptor } from "./port-descriptor.js";
import { fixtureDescriptor } from "./port-provider-fixture.test-support.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const it = createCommandTest();

it("composes standalone SQLite fragments after a canonical trigger", async () => {
  const descriptor = fixtureDescriptor();
  using source = openNodeSqliteDatabase(":memory:");
  source.exec(descriptor.sqlite);
  for (const fragment of descriptor.fragments ?? []) {
    source.exec(fragment.sqlite);
  }
  const admitted = await admitDatabasePortDescriptor({ engine: "sqlite", db: source }, descriptor);
  using destination = openNodeSqliteDatabase(":memory:");
  expect(() => destination.exec(admitted.sqlite)).not.toThrow();
});

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
