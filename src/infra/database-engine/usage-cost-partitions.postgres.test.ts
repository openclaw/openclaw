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
  "reuses report connections while refreshing and ranging PostgreSQL usage partitions",
  async () => {
    const prefix = `usagecost_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const client = new Client({ connectionString: connection });
    const databaseUrl = new URL(connection!);
    databaseUrl.pathname = `/${prefix}`;
    const databaseClient = new Client({ connectionString: databaseUrl.href });
    await client.connect();
    try {
      // Refusing new connections must not affect another test's database.
      await client.query(`CREATE DATABASE "${prefix}"`);
      await databaseClient.connect();
      await databaseClient.query("CREATE EXTENSION unaccent");
      await databaseClient.query("CREATE EXTENSION pg_trgm");
      await databaseClient.query("CREATE EXTENSION vector");
      installDatabaseEngineSelection({
        effectiveEngines: resolveDatabaseFamilyEngines({
          database: { families: { agent: { engine: "postgres" } } },
        }),
        postgres: { connection: databaseUrl.href, schemaPrefix: prefix },
      });
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
          // Warm reports must use the retained reader, even when another open is impossible.
          await client.query(`ALTER DATABASE "${prefix}" ALLOW_CONNECTIONS false`);
          try {
            expect((await read(sessionFile, 8)).summaries[0]?.totalTokens).toBe(7);
            expect((await read(sessionFile, 9)).summaries[0]?.totalTokens).toBe(11);
          } finally {
            await client.query(`ALTER DATABASE "${prefix}" ALLOW_CONNECTIONS true`);
          }
          await fs.writeFile(sessionFile, september);
          await refresh();
          expect((await read(sessionFile, 9)).summaries[0]?.totalTokens).toBe(0);
          expect((await read(sibling, 9)).summaries[0]?.totalTokens).toBe(3);
        },
      );
    } finally {
      resetDatabaseEngineSelectionForTest();
      try {
        await databaseClient.end();
      } finally {
        try {
          // No FORCE: fixture drain must close every retained report connection.
          await client.query(`DROP DATABASE IF EXISTS "${prefix}"`);
        } finally {
          await client.end();
        }
      }
    }
  },
);
