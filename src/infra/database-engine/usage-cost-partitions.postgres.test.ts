import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { assert, expect, it } from "vitest";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { refreshCostUsageCacheForAgent } from "../session-cost-usage-aggregation.js";
import {
  acquireUsageLock,
  createUsageCacheWrite as rollup,
  createUsagePartitionWrites as partitions,
} from "../session-cost-usage-cache.fixtures.test-support.js";
import {
  USAGE_COST_PARTITION_SCOPE,
  usageCostPartitionKey,
} from "../session-cost-usage-partitions.js";
import { USAGE_COST_ROLLUP_SCOPE } from "../session-cost-usage-rollup-codec.js";
import { loadSessionCostSummariesFromCache } from "../session-cost-usage.js";
import { installDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { getPostgresPhysicalFactsForPath } from "./physical-facts.js";
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

          const facts = getPostgresPhysicalFactsForPath(
            resolveOpenClawAgentSqlitePath({ agentId }),
          );
          assert(facts, "Expected the admitted PostgreSQL usage owner");
          const namespace = `"${facts.namespace.replaceAll('"', '""')}"`;
          const stored = async () =>
            (
              await databaseClient.query<{
                scope: string;
                key: string;
                value_json: string;
                blob: string | null;
                updated_at: string;
              }>(
                `SELECT scope, key, value_json, encode(blob, 'hex') AS blob,
                        updated_at::text AS updated_at
                 FROM ${namespace}.cache_entries
                 WHERE scope = ANY($1::text[]) ORDER BY scope, key`,
                [[USAGE_COST_ROLLUP_SCOPE, USAGE_COST_PARTITION_SCOPE]],
              )
            ).rows;
          const retained = await stored();
          const ids = ['batch-"雪-a', 'batch-"雪-b', "batch-append"];
          await using owner = await acquireUsageLock(agentId);
          expect(
            await owner.writeRollup(
              [...ids, "batch-unrelated"].map((id) =>
                Object.assign(rollup(id, { totalTokens: 7 }, 1, new Uint8Array([1])), {
                  partitions: partitions(["2026-01-01", "2026-02-01"], { tokens: 3 }, 2),
                }),
              ),
            ),
          ).toBe(true);
          const before = await stored();
          const update = ids.map((id, index) => ({
            ...rollup(id, { totalTokens: 20 + index }, 2, new Uint8Array([17])),
            partitions: partitions(
              [index < 2 ? "2026-03-01" : "2026-02-01"],
              { tokens: 10 + index },
              34,
            ),
            ...(index < 2 ? { replacePartitions: true } : { removedDates: ["2026-01-01"] }),
          }));
          await databaseClient.query(`
            CREATE FUNCTION ${namespace}.reject_usage_batch() RETURNS trigger
            LANGUAGE plpgsql AS $$ BEGIN
              IF NEW.key = 'batch-append' THEN RAISE EXCEPTION 'usage batch refused'; END IF;
              RETURN NEW;
            END $$;
            CREATE TRIGGER reject_usage_batch BEFORE INSERT ON ${namespace}.cache_entries
            FOR EACH ROW EXECUTE FUNCTION ${namespace}.reject_usage_batch();
          `);
          try {
            await expect(owner.writeRollup(update)).rejects.toThrow("usage batch refused");
            expect(await stored()).toEqual(before);
          } finally {
            await databaseClient.query(`
              DROP TRIGGER reject_usage_batch ON ${namespace}.cache_entries;
              DROP FUNCTION ${namespace}.reject_usage_batch();
            `);
          }
          expect(await owner.writeRollup(update)).toBe(true);
          const rows = await stored();
          const expected = ids.flatMap((id, index) => [
            {
              scope: USAGE_COST_ROLLUP_SCOPE,
              key: id,
              value_json: `{"totalTokens":${20 + index}}`,
              blob: "11",
              updated_at: "2",
            },
            {
              scope: USAGE_COST_PARTITION_SCOPE,
              key: usageCostPartitionKey(id, index < 2 ? "2026-03-01" : "2026-02-01"),
              value_json: `{"tokens":${10 + index}}`,
              blob: "22",
              updated_at: "2",
            },
          ]);
          const unrelated = before.filter((row) =>
            row.scope === USAGE_COST_ROLLUP_SCOPE
              ? row.key === "batch-unrelated"
              : row.key === usageCostPartitionKey("batch-unrelated", "2026-01-01") ||
                row.key === usageCostPartitionKey("batch-unrelated", "2026-02-01"),
          );
          expect(rows).toHaveLength(retained.length + 9);
          expect(rows).toEqual(expect.arrayContaining([...retained, ...expected, ...unrelated]));
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
