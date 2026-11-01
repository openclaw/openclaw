import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll, describe, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runProviderRoundtrip } from "./port-provider-roundtrip.test-support.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterAll);

describe.skipIf(!connection)("generic database family provider", () => {
  let client: Client;
  beforeAll(async () => {
    client = new Client({ connectionString: connection });
    await client.connect();
  });
  afterAll(async () => {
    await client?.end();
  });

  it("round-trips fragments, triggers, projections and private migration through backup/restore", async () => {
    const timings = await runProviderRoundtrip(client, tempDirs.make("port-provider-"));
    console.log("provider core timings (ms)", timings);
  }, 60_000);
});
