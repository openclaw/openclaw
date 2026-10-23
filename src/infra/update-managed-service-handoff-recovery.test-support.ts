import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Compilable } from "kysely";
import { vi } from "vitest";
import * as pidAlive from "../shared/pid-alive.js";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import * as census from "./openclaw-process-census.js";
import * as temporaryState from "./tmp-openclaw-dir.js";
import * as bootReader from "./update-managed-service-handoff-boot.js";
import * as cleanup from "./update-managed-service-handoff-cleanup.js";
import {
  createManagedHandoffLeaseDatabase,
  leaseQueries,
  readManagedHandoffRepairMetadata,
  type LeaseTable,
} from "./update-managed-service-handoff-database.js";
import {
  createManagedHandoffLeaseStore,
  type ManagedHandoffLease,
} from "./update-managed-service-handoff-lease.js";

const boot =
  process.platform === "win32"
    ? { platform: "win32" as const, identity: "2026-09-15T03:42:10.5000000Z" }
    : { platform: "linux" as const, identity: "01234567-89ab-cdef-0123-456789abcdef" };

/** The lease, repair claim, and receipts stay real; only host observations are synthetic. */
export function createManagedHandoffRecoveryFixture(root: string) {
  const control = path.join(root, "handoff-control");
  fs.mkdirSync(control, { mode: 0o700 });
  vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
  vi.spyOn(bootReader, "createManagedHandoffBootIdentityReader").mockReturnValue(() => boot);
  const births = new Map<number, number | null>([[process.pid, 10]]);
  vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockImplementation(
    (pid) => births.get(pid) ?? null,
  );
  vi.spyOn(pidAlive, "isPidDefinitelyDead").mockImplementation((pid) => !births.has(pid));
  const executor = { pid: 1_000_001, startIdentity: "11" };
  const helper = { pid: 1_000_002, startIdentity: "12" };
  const artifactPath = path.join(root, "retained-artifacts");
  fs.mkdirSync(artifactPath, { mode: 0o700 });
  const diagnosticPath = path.join(artifactPath, "diagnostic.log");
  fs.writeFileSync(diagnosticPath, "Retained update diagnostics\n");
  const facts: Awaited<ReturnType<typeof cleanup.readManagedHandoffRepairFacts>> = {
    runIds: ["retained-update"],
    artifactPaths: [artifactPath],
    timeoutMs: null,
  };
  const repairFacts = vi.spyOn(cleanup, "readManagedHandoffRepairFacts").mockResolvedValue(facts);
  const processCensus: {
    matchingPids: number[];
    unverifiedPids: number[];
    warnings?: string[];
    error?: string;
  } = {
    matchingPids: [],
    unverifiedPids: [],
  };
  const runCensus = new Map<string, typeof processCensus>();
  // Processes whose argv or cwd names a retained path, keyed by that path.
  const pathCensus = new Map<string, number[]>();
  function inspect(references: {
    runId: string;
    artifactPaths: readonly string[];
  }): typeof processCensus;
  function inspect(): { pids: number[] };
  function inspect(references?: { runId: string; artifactPaths: readonly string[] }) {
    if (!references) {
      return { pids: processCensus.matchingPids };
    }
    const holders = references.artifactPaths.flatMap((entry) => pathCensus.get(entry) ?? []);
    return holders.length
      ? { matchingPids: holders, unverifiedPids: [] }
      : (runCensus.get(references.runId) ?? processCensus);
  }
  vi.spyOn(census, "inspectOtherOpenClawProcesses").mockImplementation(inspect);
  const databasePath = path.join(control, "managed-update-handoffs.sqlite");
  const database = createManagedHandoffLeaseDatabase(databasePath);
  const store = createManagedHandoffLeaseStore({ databasePath, serviceManagerEnv: {} });
  const current = (key = root) => {
    const found = store.read(key);
    assert(found.kind === "current", "Expected a retained handoff");
    return found.lease;
  };
  const mutate = (query: (tables: ReturnType<typeof leaseQueries>) => Compilable, key = root) => {
    database(true, (db) => executeSqliteQuerySync(db, query(leaseQueries(db))));
    return current(key);
  };
  const insert = (rows: LeaseTable[]) =>
    database(true, (db) =>
      executeSqliteQuerySync(
        db,
        leaseQueries(db).insertInto("managed_update_handoffs").values(rows),
      ),
    );
  const candidate = { pid: 1_000_004, startIdentity: "14" };
  return {
    root,
    store,
    births,
    helper,
    candidate,
    processCensus,
    runCensus,
    pathCensus,
    repairFacts,
    facts,
    diagnosticPath,
    current,
    insert,
    rows: () =>
      database(false, (db) =>
        executeSqliteQuerySync(
          db,
          leaseQueries(db)
            .selectFrom("managed_update_handoffs")
            .select(["install_root", "owner", "payload_json", "updated_at"])
            .orderBy("install_root"),
        ),
      ).rows,
    /** Rows a cancelled original leaves when it dies before joining its candidate:
     * its v4 generation, a retained service root, an occupied-slot mirror, and the
     * candidate lineage under each root, in the shapes their producers write. */
    seedCancellation(options: { ageMs?: number; serviceAgeMs?: number } = {}) {
      const at = (ageMs = 45 * 60_000 + 1_000) => Date.now() - ageMs;
      const updatedAt = at(options.ageMs);
      const original = { kind: "update", mutationProtocol: "original-cancellation-v1" };
      const generation = (key: string, owner: string, action: object, time = updatedAt) => ({
        key,
        owner,
        payload: JSON.stringify({ version: 2, executor, helper: executor, action }),
        updatedAt: time,
      });
      const cancel = (cancellation: ReturnType<typeof generation>, action: object) => ({
        install_root: cancellation.key,
        owner: cancellation.owner,
        payload_json: JSON.stringify({
          version: 4,
          helper: executor,
          executor,
          action,
          cancellation,
        }),
        updated_at: cancellation.updatedAt + 1,
      });
      const keys = { slot: `${root}-slot`, service: `${root}-service` };
      const originalGeneration = generation(root, "original-owner", original);
      const lineage = `/.openclaw-update-child-01234567-89ab-cdef-0123-456789abcdef-lineage-${"b".repeat(64)}`;
      const child = (parent: string, action: object) => ({
        install_root: parent + lineage,
        owner: "retained-update",
        payload_json: JSON.stringify({ version: 2, helper: executor, executor: candidate, action }),
        updated_at: updatedAt,
      });
      insert([
        cancel(originalGeneration, original),
        cancel(
          generation(
            keys.service,
            "service-owner",
            { kind: "update" },
            options.serviceAgeMs === undefined ? updatedAt : at(options.serviceAgeMs),
          ),
          { kind: "update" },
        ),
        {
          install_root: keys.slot,
          owner: "original-owner",
          payload_json: JSON.stringify({
            version: 2,
            executor,
            helper: executor,
            action: { kind: "update" },
            mutationOriginal: originalGeneration,
          }),
          updated_at: updatedAt,
        },
        child(root, original),
        child(keys.slot, { kind: "update" }),
        child(keys.service, { kind: "update" }),
      ]);
      return { ...keys, lineage, updater: executor };
    },
    seed(
      options: { ageMs?: number; timeoutMs?: number; legacy?: string } = {},
    ): ManagedHandoffLease {
      const updatedAt = Date.now() - (options.ageMs ?? 45 * 60_000 + 1_000);
      const key = options.legacy ? `${root}/.openclaw-update-child-${options.legacy}` : root;
      const payload = JSON.stringify({
        version: 2,
        executor,
        helper,
        action: options.legacy
          ? { kind: "update" }
          : { kind: "triage", phase: "uncertain", lifetime: { kind: "foreground", boot } },
      });
      facts.timeoutMs = options.timeoutMs ?? null;
      return mutate(
        (tables) =>
          tables.insertInto("managed_update_handoffs").values({
            install_root: key,
            owner: "prior-owner",
            payload_json: payload,
            updated_at: updatedAt,
          }),
        key,
      );
    },
    readMetadata(lease: ManagedHandoffLease) {
      return database(true, (db) =>
        readManagedHandoffRepairMetadata(db, lease, (operation) =>
          database.transact(db, operation, {}),
        ),
      );
    },
    replaceHeartbeat(lease: ManagedHandoffLease) {
      return mutate((tables) =>
        tables
          .updateTable("managed_update_handoffs")
          .set({ updated_at: lease.updatedAt + 1 })
          .where("install_root", "=", root),
      );
    },
  };
}
