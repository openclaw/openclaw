import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveBundledPluginsDir } from "../../plugins/bundled-dir.js";
import { resolveDatabaseEngineInput } from "./config.js";
import type { PortDescriptor } from "./port.worker.js";
import { expectedPostgresCatalog } from "./postgres-catalog.js";
import metadata from "./workboard-port.generated.json" with { type: "json" };

export async function loadWorkboardPortDescriptor(): Promise<PortDescriptor> {
  const plugins = resolveBundledPluginsDir();
  if (!plugins) {
    throw new Error("Bundled workboard port descriptor is unavailable.");
  }
  const postgres = await fs.readFile(
    path.join(plugins, "workboard/src/workboard-schema.postgres.sql"),
    "utf8",
  );
  return {
    ...metadata,
    preData: postgres.slice(metadata.preData[0], metadata.preData[1]),
    postData: postgres.slice(metadata.postData[0], metadata.postData[1]),
    expectedCatalog: expectedPostgresCatalog(metadata),
  };
}

export async function withWorkboardPostgres<T>(
  config: OpenClawConfig,
  run: (client: import("pg").Client, descriptor: PortDescriptor) => Promise<T>,
): Promise<T> {
  const input = await resolveDatabaseEngineInput(config);
  if (!input) {
    throw new Error("PostgreSQL requires database.engine=postgres and a resolvable connection.");
  }
  const { Client } = await import("pg");
  const client = new Client({ connectionString: input.connection });
  // Query promises report failures; the error event must not abort offline recovery.
  client.on("error", () => undefined);
  await client.connect();
  try {
    return await run(client, await loadWorkboardPortDescriptor());
  } finally {
    await client.end();
  }
}
