import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { expect, it } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { refreshCostUsageCacheForAgent } from "../session-cost-usage-aggregation.js";
import { loadSessionCostSummariesFromCache } from "../session-cost-usage.js";
import { installDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;

it.skipIf(!connection)(
  "refreshes and ranges PostgreSQL usage partitions for quoted source paths",
  async () => {
    const prefix = `usagecost_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const client = new Client({ connectionString: connection });
    await client.connect();
    installDatabaseEngineSelection({
      effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
      postgres: { connection: connection!, schemaPrefix: prefix },
    });
    try {
      await withOpenClawTestState(
        { scenario: "minimal", prepareProfileCatalog: false },
        async (state) => {
          const agentId = "usage-partitions";
          const sessionsDir = state.sessionsDir(agentId);
          await fs.mkdir(sessionsDir, { recursive: true });
          const sessionFile = path.join(sessionsDir, 'quoted-"snow:雪.jsonl');
          const sibling = path.join(sessionsDir, 'quoted-"snow:雪-more.jsonl');
          const event = (id: string, month: string, tokens: number) =>
            JSON.stringify({
              type: "message",
              id,
              timestamp: `2026-${month}-18T00:00:00Z`,
              message: {
                role: "assistant",
                provider: "test",
                model: "test",
                usage: { input: tokens, output: 0, totalTokens: tokens },
              },
            }) + "\n";
          const september = event("september", "09", 7);
          await fs.writeFile(sessionFile, september + event("october", "10", 11));
          await fs.writeFile(sibling, event("sibling", "10", 3));
          const refresh = () =>
            refreshCostUsageCacheForAgent({
              config: {},
              agentId,
              sessionFiles: [sessionFile, sibling],
            });
          const read = (file: string, month: number) =>
            loadSessionCostSummariesFromCache({
              config: {},
              agentId,
              sessions: [{ sessionFile: file }],
              startMs: Date.UTC(2026, month, 1),
              endMs: Date.UTC(2026, month + 1, 1) - 1,
              requestRefresh: false,
            });
          await refresh();
          expect((await read(sessionFile, 8)).summaries[0]?.totalTokens).toBe(7);
          expect((await read(sessionFile, 9)).summaries[0]?.totalTokens).toBe(11);
          await fs.writeFile(sessionFile, september);
          await refresh();
          expect((await read(sessionFile, 9)).summaries[0]?.totalTokens).toBe(0);
          expect((await read(sibling, 9)).summaries[0]?.totalTokens).toBe(3);
        },
      );
    } finally {
      try {
        const schemas = await client.query<{ nspname: string }>(
          "SELECT nspname FROM pg_namespace WHERE left(nspname, $1) = $2",
          [prefix.length + 1, `${prefix}_`],
        );
        for (const { nspname } of schemas.rows) {
          await client.query(`DROP SCHEMA "${nspname}" CASCADE`);
        }
      } finally {
        await client.end();
        resetDatabaseEngineSelectionForTest();
      }
    }
  },
);
