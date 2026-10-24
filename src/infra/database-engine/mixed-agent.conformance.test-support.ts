import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resetConfigRuntimeState } from "../../config/runtime-snapshot.js";
import { installGatewayDatabaseEngine } from "../../gateway/server-database-engine.js";
import { closeOpenClawAgentDatabases } from "../../state/openclaw-agent-db-lifecycle.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { dropPostgresTestSchemas } from "../postgres-sync/schema-cleanup.test-support.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import type { DatabaseEngineId } from "./types.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
export const mixedAgentConnection = typeof configured === "string" ? configured : undefined;
export const mixedAgentPairs = [
  { stateEngine: "sqlite", agentEngine: "sqlite" },
  { stateEngine: "postgres", agentEngine: "postgres" },
  { stateEngine: "postgres", agentEngine: "sqlite" },
  { stateEngine: "sqlite", agentEngine: "postgres" },
] as const;

/** One config-driven Gateway boot and database lifecycle per pair, shared by its cases. */
export function useMixedAgentPair(stateEngine: DatabaseEngineId, agentEngine: DatabaseEngineId) {
  let root: string;
  const prefix = `mixed_agent_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const dirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterAll(async () => {
      try {
        withEngineStoreAdmission(() => closeOpenClawAgentDatabases(root));
        await cleanupSessionStateForTest({ stateDir: root });
        if (mixedAgentConnection) {
          const client = new Client({ connectionString: mixedAgentConnection });
          await client.connect();
          try {
            await dropPostgresTestSchemas(client, prefix);
          } finally {
            await client.end();
          }
        }
      } finally {
        resetDatabaseEngineSelectionForTest();
        resetConfigRuntimeState();
        vi.unstubAllEnvs();
        cleanup();
      }
    }),
  );
  beforeAll(async () => {
    root = dirs.make("mixed-agent-pair-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
    fs.writeFileSync(
      process.env.OPENCLAW_CONFIG_PATH!,
      JSON.stringify(
        stateEngine === "postgres" || agentEngine === "postgres"
          ? {
              database: {
                engine: "sqlite",
                families: { state: { engine: stateEngine }, agent: { engine: agentEngine } },
                postgres: { connection: mixedAgentConnection!, schemaPrefix: prefix },
              },
            }
          : {},
      ),
    );
    resetDatabaseEngineSelectionForTest();
    resetConfigRuntimeState();
    await installGatewayDatabaseEngine();
  });
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
  });
  return {
    get root() {
      return root;
    },
  };
}
