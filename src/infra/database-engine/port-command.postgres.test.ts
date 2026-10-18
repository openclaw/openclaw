import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runDatabasePortTask as runWorkboardPortTask } from "./port-command.worker.js";
import { readPostgresPortCapabilities } from "./port.worker.js";
import { workboardPortProvider } from "./workboard-port.js";
const loadWorkboardPortDescriptor = () => workboardPortProvider.loadDescriptor();

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
    readPostgresPortCapabilities(client, await loadWorkboardPortDescriptor()),
  ).rejects.toThrow("required PostgreSQL >=16 and UTF8 server/client");
});

it("redacts unresolved connection SecretRefs", async () => {
  const config: OpenClawConfig = {
    database: {
      engine: "postgres",
      postgres: {
        connection: {
          source: "env",
          provider: "default",
          id: "OPENCLAW_PORT_TEST_UNRESOLVED_CONNECTION",
        },
      },
    },
  };
  const result = runWorkboardPortTask({ operation: "preflight", config, probe: false }, scope);
  await expect(result).rejects.toThrow("preflight:");
  await expect(result).rejects.not.toThrow("OPENCLAW_PORT_TEST_UNRESOLVED_CONNECTION");
});

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
            config: { database: { engine: "postgres", postgres: { connection: connection! } } },
          },
          scope,
        ),
      ).resolves.toMatchObject({ encoding: "UTF8", privilegesChecked: false });
    } finally {
      vi.unstubAllEnvs();
    }
  },
);
