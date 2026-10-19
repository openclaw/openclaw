import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runDatabasePortTask as runWorkboardPortTask } from "./port-command.worker.js";
import { readPostgresPortCapabilities } from "./port.worker.js";
import { workboardPortProvider } from "./workboard-port.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scope = { assertCurrent() {} };
afterEach(() => vi.restoreAllMocks());

it.each([
  { version: 150000, encoding: "UTF8", client_encoding: "UTF8" },
  { version: 170000, encoding: "LATIN1", client_encoding: "UTF8" },
  { version: 170000, encoding: "UTF8", client_encoding: "LATIN1" },
])("rejects incompatible PostgreSQL capabilities %j at the query boundary", async (facts) => {
  const client = Object.assign(new Client({ host: "127.0.0.1", port: 1 }), {
    query: vi.fn(async () => ({
      rows: [facts],
      rowCount: 1,
      command: "SELECT",
      oid: 0,
      fields: [],
    })),
  });
  await expect(
    readPostgresPortCapabilities(client, await workboardPortProvider.loadDescriptor()),
  ).rejects.toThrow("required PostgreSQL >=16 and UTF8 server/client");
});

it("redacts unresolved connection SecretRefs", async () => {
  const secret = {
    source: "env" as const,
    provider: "default",
    id: "OPENCLAW_PORT_TEST_UNRESOLVED_CONNECTION",
  };
  const result = runWorkboardPortTask(
    { operation: "preflight", config: postgresConfig(secret), probe: false },
    scope,
  );
  await expect(result).rejects.toThrow("preflight:");
  await expect(result).rejects.not.toThrow(secret.id);
});

function postgresConfig(dsn: string | { source: "env"; provider: string; id: string }) {
  return { database: { engine: "postgres" as const, postgres: { connection: dsn } } };
}

it.skipIf(!connection)(
  "preflights PostgreSQL while optional plugin artifacts are absent",
  async () => {
    const empty = tempDirs.make("port-preflight-empty-bundled-");
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", empty);
    vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
    try {
      await expect(
        runWorkboardPortTask(
          {
            operation: "preflight",
            probe: false,
            config: postgresConfig(connection!),
          },
          scope,
        ),
      ).resolves.toMatchObject({ encoding: "UTF8", privilegesChecked: false });
    } finally {
      vi.unstubAllEnvs();
    }
  },
);
