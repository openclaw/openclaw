import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  MessageChannel,
  receiveMessageOnPort,
  type MessagePort,
  type WorkerOptions,
} from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { assertDoctorAgentLeaseAdmission } from "../commands/doctor-agent-lease-refusal.js";
import { withMaintenance } from "../commands/doctor-schema-migrations.test-support.js";
import { getSqliteDatabaseSchemaRevision } from "../infra/sqlite-database-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { AGENT_DATABASE_MAINTENANCE_LEASE } from "./openclaw-agent-db-lease.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
  prepareOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import { leaseHeartbeatState } from "./openclaw-state-lease-heartbeat-shared.js";

const observer = vi.hoisted(() => ({
  driver: undefined as URL | undefined,
  port: undefined as MessagePort | undefined,
  beforeCreate: undefined as (() => void) | undefined,
  shared: undefined as BigInt64Array | undefined,
}));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const [{ runtimeProcessEntrypoints }, { resolveRuntimeWorkerUrl }] = await Promise.all([
    import("../infra/runtime-process-entrypoints.js"),
    import("../infra/runtime-worker-url.js"),
  ]);
  const heartbeatUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.stateLeaseHeartbeat);
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options: WorkerOptions = {}) {
        if (String(filename) === heartbeatUrl.href && observer.driver && observer.port) {
          observer.beforeCreate?.();
          observer.shared = new BigInt64Array(options.workerData.shared);
          super(observer.driver, {
            ...options,
            workerData: {
              ...options.workerData,
              fixtureObserver: observer.port,
              fixtureEntry: heartbeatUrl.href,
            },
            transferList: [...(options.transferList ?? []), observer.port],
          });
        } else {
          super(filename, options);
        }
      }
    },
  };
});

afterEach(() => {
  observer.driver = undefined;
  observer.port = undefined;
  observer.beforeCreate = undefined;
  observer.shared = undefined;
});

type Request = { decision: SharedArrayBuffer; requestedAt: number };

function takeRequests(port: MessagePort): Request[] {
  const requests: Request[] = [];
  for (let queued = receiveMessageOnPort(port); queued; queued = receiveMessageOnPort(port)) {
    requests.push(queued.message as Request);
  }
  return requests;
}

function hasProvenance(database: DatabaseSync): boolean {
  return database
    .prepare("PRAGMA table_info(agent_database_leases)")
    .all()
    .some((row) => row.name === "provenance");
}

it.each([true, false])(
  "renews maintenance across schema preparation with provenance present=%s",
  async (present) => {
    await withOpenClawTestState({ label: "maintenance-schema-renewal" }, async (state) => {
      const seeded = openOpenClawStateDatabase({ env: state.env });
      // Missing first-use provenance is a supported persisted schema, not a live DDL injection.
      if (!present) {
        seeded.db.exec("ALTER TABLE agent_database_leases DROP COLUMN provenance");
      }
      const pathname = seeded.path;
      await closeOpenClawStateDatabaseByPathAsync(pathname);
      await assertDoctorAgentLeaseAdmission(state.env);
      await withMaintenance(async () => {
        const prepared = await prepareOpenClawStateDatabaseSchema(
          { env: state.env, integrityCheck: "quick" },
          "doctor-preparation",
        );
        expect(prepared.warnings).toEqual([]);
        const shared = openOpenClawStateDatabase({ env: state.env });
        using reader = new DatabaseSync(pathname, { readOnly: true });
        expect(hasProvenance(reader)).toBe(present);
        expect(reader.prepare("SELECT lease_id FROM agent_database_leases").all()).toEqual([]);
        const beforeRevision = getSqliteDatabaseSchemaRevision(shared.db);
        let atWorkerCreation: boolean | undefined;
        const observations = new MessageChannel();
        observer.port = observations.port2;
        observer.beforeCreate = () => {
          atWorkerCreation = hasProvenance(reader);
        };
        observer.driver = pathToFileURL(
          await state.writeText(
            "heartbeat-observer.mts",
            `
        import { workerData } from "node:worker_threads";
        const port = workerData.databaseAdmissionPort;
        const post = port.postMessage.bind(port);
        port.postMessage = (message, transfers) => {
          const sent = post(message, transfers);
          if (message?.kind === "sqlite-database-admissions") {
            workerData.fixtureObserver.postMessage({ decision: message.decision, requestedAt: Date.now() });
          }
          return sent;
        };
        await import(workerData.fixtureEntry);
      `,
          ),
        );
        let entered = false;
        let captured:
          | {
              atWorkerCreation: boolean | undefined;
              provenance: boolean;
              ready: boolean;
              writerHeld: boolean;
              schemaChanged: boolean;
              blockedAt: number;
              observedAt: number;
              requests: { requestedAt: number; decision: number }[];
              before: ReturnType<typeof readLease>;
              after: ReturnType<typeof readLease>;
            }
          | undefined;
        const readLease = () =>
          reader
            .prepare(
              "SELECT heartbeat_at, expires_at FROM state_leases WHERE scope = ? AND lease_key = ?",
            )
            .get(AGENT_DATABASE_MAINTENANCE_LEASE.scope, AGENT_DATABASE_MAINTENANCE_LEASE.key);
        try {
          const outcome = await withAgentDatabaseMaintenanceLease(
            { env: state.env, leaseMs: 10_000, processBound: true },
            async () => {
              entered = true;
              const provenance = hasProvenance(reader);
              const ready =
                Atomics.load(observer.shared!, leaseHeartbeatState.status) ===
                leaseHeartbeatState.ready;
              const writerHeld = shared.db.isTransaction;
              const revision = getSqliteDatabaseSchemaRevision(shared.db);
              takeRequests(observations.port1);
              const before = readLease()!;
              const blockedAt = Date.now();
              // No event-loop yields or shared writer: only the real worker can renew during this interval.
              Atomics.wait(
                new Int32Array(new SharedArrayBuffer(4)),
                0,
                0,
                Number(before.expires_at) - Date.now() + 10_000 + 250,
              );
              const observedAt = Date.now();
              const requests = takeRequests(observations.port1);
              const after = readLease()!;
              captured = {
                atWorkerCreation,
                provenance,
                ready,
                writerHeld,
                schemaChanged: revision !== beforeRevision,
                blockedAt,
                requests: requests.map((request) => ({
                  requestedAt: request.requestedAt,
                  decision: Atomics.load(new Int32Array(request.decision), 0),
                })),
                before,
                after,
                observedAt,
              };
            },
          ).then(
            () => ({ status: "fulfilled" as const }),
            (error: unknown) => ({ status: "rejected" as const, error }),
          );
          expect(entered).toBe(true);
          expect(captured).toBeDefined();
          // Lease cleanup can replace a callback error with authority loss. Assert the
          // immutable observation only after that owner has settled, so proof cannot be masked.
          const snapshot = captured!;
          console.log("maintenance-schema-renewal", present, JSON.stringify(snapshot));
          expect(snapshot.atWorkerCreation).toBe(present);
          expect(snapshot.provenance).toBe(true);
          expect(snapshot.ready).toBe(true);
          expect(snapshot.writerHeld).toBe(false);
          expect(snapshot.schemaChanged).toBe(!present);
          expect(snapshot.before).toBeDefined();
          expect(snapshot.after).toBeDefined();
          const { before, after, requests, observedAt } = snapshot;
          expect(observedAt).toBeGreaterThan(Number(before!.heartbeat_at) + 20_000);
          expect(requests).toEqual([]);
          // More than two original TTLs rules out one renewal followed by a
          // blocked cache-publication acknowledgement on the next interval.
          expect(Number(after!.heartbeat_at)).toBeGreaterThan(Number(before!.expires_at));
          expect(Number(after!.expires_at)).toBeGreaterThan(observedAt);
          console.log(
            "maintenance-schema-renewal-settlement",
            present,
            outcome.status,
            outcome.status === "rejected" ? String(outcome.error) : "",
          );
          if (outcome.status === "rejected") {
            throw outcome.error;
          }
        } finally {
          observations.port1.close();
          observations.port2.close();
        }
      });
    });
  },
);
