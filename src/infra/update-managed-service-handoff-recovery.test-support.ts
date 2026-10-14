import fs from "node:fs";
import path from "node:path";
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
  const processCensus: { matchingPids: number[]; unverifiedPids: number[]; error?: string } = {
    matchingPids: [],
    unverifiedPids: [],
  };
  const runCensus = new Map<string, typeof processCensus>();
  function inspect(references: {
    runId: string;
    artifactPaths: readonly string[];
  }): typeof processCensus;
  function inspect(): { pids: number[] };
  function inspect(references?: { runId: string; artifactPaths: readonly string[] }) {
    return references
      ? (runCensus.get(references.runId) ?? processCensus)
      : { pids: processCensus.matchingPids };
  }
  vi.spyOn(census, "inspectOtherOpenClawProcesses").mockImplementation(inspect);
  const databasePath = path.join(control, "managed-update-handoffs.sqlite");
  const database = createManagedHandoffLeaseDatabase(databasePath);
  const store = createManagedHandoffLeaseStore({ databasePath, serviceManagerEnv: {} });
  const current = () => {
    const found = store.read(root);
    if (found.kind !== "current") {
      throw new Error("Expected a retained handoff");
    }
    return found.lease;
  };
  return {
    root,
    store,
    births,
    helper,
    processCensus,
    runCensus,
    repairFacts,
    facts,
    diagnosticPath,
    current,
    seed(options: { ageMs?: number; timeoutMs?: number } = {}): ManagedHandoffLease {
      const updatedAt = Date.now() - (options.ageMs ?? 45 * 60_000 + 1_000);
      const payload = JSON.stringify({
        version: 2,
        executor,
        helper,
        action: { kind: "triage", phase: "uncertain", lifetime: { kind: "foreground", boot } },
      });
      facts.timeoutMs = options.timeoutMs ?? null;
      database(true, (db) =>
        executeSqliteQuerySync(
          db,
          leaseQueries(db).insertInto("managed_update_handoffs").values({
            install_root: root,
            owner: "prior-owner",
            payload_json: payload,
            updated_at: updatedAt,
          }),
        ),
      );
      return current();
    },
    readMetadata(lease: ManagedHandoffLease) {
      return database(true, (db) =>
        readManagedHandoffRepairMetadata(db, lease, (operation) =>
          database.transact(db, operation, {}),
        ),
      );
    },
    replaceHeartbeat(lease: ManagedHandoffLease) {
      database(true, (db) =>
        executeSqliteQuerySync(
          db,
          leaseQueries(db)
            .updateTable("managed_update_handoffs")
            .set({ updated_at: lease.updatedAt + 1 })
            .where("install_root", "=", root),
        ),
      );
      return current();
    },
  };
}
