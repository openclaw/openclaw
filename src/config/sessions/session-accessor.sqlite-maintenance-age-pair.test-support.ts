import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { availableParallelism, cpus, loadavg, totalmem } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import { expect, vi } from "vitest";
import { withEngineStoreAdmission as admit } from "../../infra/database-engine/admission-scope.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { readSessionEntryCount, writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { readSessionMaintenanceAgeQueries as baseline } from "./session-accessor.sqlite-maintenance-age-baseline.test-support.js";
import * as queryOwner from "./session-accessor.sqlite-maintenance-age-queries.js";
import {
  invalidateSessionEntryMaintenanceAgeFact,
  SESSION_ENTRY_MAINTENANCE_INTERVAL_MS,
} from "./session-accessor.sqlite-maintenance-age.js";
import { runSessionMaintenanceMetadataInTransaction } from "./session-accessor.sqlite-maintenance-transaction.js";
import { resolveSessionReclamationDatabaseOptions } from "./session-accessor.sqlite-reclamation.js";
import { prepareSessionMaintenancePreservation } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

const DAY_MS = 86_400_000;
const baselineRevision = "21fbe8378db0928a642f8285585f5e2fd0fd37d6";
const candidateRevision = "7c2ff8f775acca3e5c93c9c22b6247e37df29bae";

function blobId(relativePath: string) {
  const bytes = readFileSync(new URL(relativePath, import.meta.url));
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** Temporary experiment: compare exact query owners inside one real PostgreSQL caller. */
export async function measurePostgresMaintenanceAgePair() {
  const started = performance.now();
  const baselineBlob = blobId("./session-accessor.sqlite-maintenance-age-baseline.test-support.ts");
  const candidateBlob = blobId("./session-accessor.sqlite-maintenance-age-queries.ts");
  expect(baselineBlob).toBe("c409f49af395da02ab8feee23c232d6d4d8f5931");
  expect(candidateBlob).toBe("e2e02b091d543f42b72cbcb0cd6138538084a854");
  const candidate = queryOwner.readSessionMaintenanceAgeQueries;
  const variants = { baseline, candidate };
  type Variant = keyof typeof variants;
  let selected: Variant = "baseline";
  const commonPaths = [
    "./session-accessor.sqlite-maintenance-age.ts",
    "./session-accessor.sqlite-maintenance-store.ts",
    "./session-accessor.sqlite-maintenance-transaction.ts",
    "../../infra/kysely-sync.ts",
    "../../infra/postgres-sync/connection.ts",
    "../../infra/postgres-sync/bridge.worker.ts",
    "../../infra/postgres-sync/protocol.ts",
    "../../../package.json",
    "../../../pnpm-lock.yaml",
  ];
  console.log(
    "PG_AGE_PAIR_IDENTITY " +
      JSON.stringify({
        baselineRevision,
        baselineBlob,
        candidateRevision,
        candidateBlob,
        commonCheckout: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        commonBlobs: Object.fromEntries(commonPaths.map((name) => [name, blobId(name)])),
        node: process.version,
        isMainThread,
        threadId,
        availableParallelism: availableParallelism(),
        cpuModel: cpus()[0]?.model,
        totalMemoryBytes: totalmem(),
        cpuScope: "executing test thread; excludes PostgreSQL bridge and server",
        timingScope: "warm admitted maintenance-plan transaction; setup and reset excluded",
      }),
  );
  const samples: Array<{
    scenario: string;
    pair: number;
    position: number;
    variant: Variant;
    wallMs: number;
    threadCpuUs: number;
    loadBefore: number[];
    loadAfter: number[];
  }> = [];
  const selector = vi
    .spyOn(queryOwner, "readSessionMaintenanceAgeQueries")
    .mockImplementation((database) => variants[selected](database));
  try {
    for (const protectedRows of [false, true]) {
      const options = {
        agentId: protectedRows ? "pair-protected" : "pair-ordinary",
        env: process.env,
      };
      const database = admit(() => openOpenClawAgentDatabase(options));
      if (!isPostgresSqlConnection(database.db)) {
        throw new Error("The paired experiment requires real PostgreSQL");
      }
      const db = database.db;
      const seedAt = Date.now();
      admit(() =>
        runOpenClawAgentWriteTransaction((writer) => {
          expect(writer.db).toBe(db);
          for (let index = 0; index < 1_024; index++) {
            const key = `agent:${options.agentId}:ordinary-${String(index).padStart(4, "0")}${protectedRows ? ":thread:t1" : ""}`;
            const timestamp = seedAt - (index < 512 ? 28 : 1) * DAY_MS;
            writeSessionEntry(writer, key, {
              sessionId: key,
              updatedAt: timestamp,
              lastActivityAt: timestamp,
              lastInteractionAt: timestamp,
              sessionStartedAt: timestamp,
            });
          }
        }, options),
      );
      const preservation = await prepareSessionMaintenancePreservation(database.path);
      try {
        expect(preservation.capture()).toEqual({
          providerKeys: [],
          workIdentities: [],
          lifecycleIdentities: [],
        });
        for (const recent of protectedRows ? [false] : [false, true]) {
          const scenario = protectedRows ? "all-protected" : recent ? "recent-on" : "recent-off";
          const plan = {
            kind: "maintenance-plan" as const,
            databaseOptions: resolveSessionReclamationDatabaseOptions(options),
            input: {
              storePath: database.path,
              archiveDirectory: path.join(path.dirname(database.path), "archives"),
              preservation: preservation.capture(),
              maintenance: {
                ...resolveMaintenanceConfigFromInput({ mode: "enforce", maxEntries: 10_000 }),
                pruneAfterMs: 30 * DAY_MS,
                archiveDashboardAfterMs: null,
                preserveRecentMs: recent ? 7 * DAY_MS : null,
              },
            },
          };
          const run = (variant: Variant) => {
            // Both arms use the same selector. Reset outside timing so a retained age fact
            // cannot silently turn a measured preparation into a cache hit.
            selected = variant;
            invalidateSessionEntryMaintenanceAgeFact(db);
            selector.mockClear();
            const loadBefore = loadavg();
            const clockBefore = Date.now();
            const cpu = process.threadCpuUsage();
            const begin = performance.now();
            const result = admit(() => runSessionMaintenanceMetadataInTransaction(plan, {}));
            const wallMs = performance.now() - begin;
            const used = process.threadCpuUsage(cpu);
            const clockAfter = Date.now();
            const loadAfter = loadavg();
            expect(selector).toHaveBeenCalledTimes(1);
            expect(selector).toHaveBeenCalledWith(db);
            if (result.kind !== "maintenance-plan" || !result.ageFact) {
              throw new Error("Expected a completed maintenance plan with its recorded age fact");
            }
            expect(result.value).toEqual({
              archivedEntries: [],
              entryRemovals: [],
              stateDeletePlans: [],
              archived: 0,
              capArchived: 0,
              modelRunPruned: 0,
              pruned: 0,
              capped: 0,
            });
            expect(result.ageFact.entryCount).toBe(1_024);
            expect(result.ageFact.next.at).toBe(protectedRows ? Infinity : seedAt + 2 * DAY_MS + 1);
            expect(result.ageFact.recheckAt).toBeGreaterThanOrEqual(
              clockBefore + SESSION_ENTRY_MAINTENANCE_INTERVAL_MS,
            );
            expect(result.ageFact.recheckAt).toBeLessThanOrEqual(
              clockAfter + SESSION_ENTRY_MAINTENANCE_INTERVAL_MS,
            );
            expect(result.nextAt).toBe(result.ageFact.recheckAt);
            return { wallMs, threadCpuUs: used.user + used.system, loadBefore, loadAfter };
          };
          for (let warmup = 0; warmup < 2; warmup++) {
            run("baseline");
            run("candidate");
          }
          for (let pair = 0; pair < 5; pair++) {
            const order: Variant[] =
              pair % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
            order.forEach((variant, position) => {
              const sample = { scenario, pair, position, variant, ...run(variant) };
              samples.push(sample);
              console.log("PG_AGE_PAIR_SAMPLE " + JSON.stringify(sample));
            });
          }
          // Query capture is deliberately separate from every reported timing sample.
          for (const variant of ["baseline", "candidate"] as const) {
            const query = db.query.bind(db);
            const pages: number[] = [];
            const observed = vi.spyOn(db, "query").mockImplementation((sql, parameters) => {
              const result = query(sql, parameters);
              if (
                result.columns.map((column) => column.name).join(",") === "session_key,updated_at"
              ) {
                expect(sql).toContain("session_nodes");
                pages.push(result.rows.length);
              }
              return result;
            });
            try {
              run(variant);
              expect(pages.length).toBeGreaterThan(0);
              expect(pages.reduce((total, rows) => total + rows, 0)).toBe(
                variant === "baseline" || protectedRows ? 1_024 : 64,
              );
              console.log(
                "PG_AGE_PAIR_QUERIES " +
                  JSON.stringify({
                    scenario,
                    variant,
                    pages,
                    nextAt: protectedRows ? "Infinity" : seedAt + 2 * DAY_MS + 1,
                  }),
              );
            } finally {
              observed.mockRestore();
            }
          }
          expect(admit(() => readSessionEntryCount(database, { includeArchived: false }))).toBe(
            1_024,
          );
        }
      } finally {
        preservation.dispose();
      }
    }
    expect(samples).toHaveLength(30);
    console.log(
      "PG_AGE_PAIR_COMPLETE " +
        JSON.stringify({ samples: samples.length, experimentMs: performance.now() - started }),
    );
  } finally {
    selector.mockRestore();
  }
}
