import fs from "node:fs";
import path from "node:path";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { runSqliteIntegrityOperationInWorker } from "../infra/sqlite-integrity-operation.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { AGENT_DATABASE_MAINTENANCE_LEASE } from "./openclaw-agent-db-lease.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import { ensureOpenClawAgentDatabaseSchemaSteps } from "./openclaw-agent-db-schema.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { leaseHeartbeatState } from "./openclaw-state-lease-heartbeat-shared.js";

const heartbeat = vi.hoisted(() => ({
  now: 0,
  worker: undefined as Worker | undefined,
  shared: undefined as BigInt64Array | undefined,
  completion: undefined as Int32Array | undefined,
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
        const isHeartbeat = String(filename) === heartbeatUrl.href;
        const completion = isHeartbeat
          ? new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
          : undefined;
        super(
          isHeartbeat
            ? new URL("./openclaw-agent-db-leasehold-heartbeat.test-support.mjs", import.meta.url)
            : filename,
          isHeartbeat
            ? {
                ...options,
                workerData: {
                  ...options.workerData,
                  fixtureEntrypoint: String(filename),
                  fixtureNow: heartbeat.now,
                  fixtureCompletion: completion!.buffer,
                },
              }
            : options,
        );
        if (isHeartbeat) {
          heartbeat.worker = this;
          heartbeat.shared = new BigInt64Array(options.workerData.shared);
          heartbeat.completion = completion;
        }
      }
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  heartbeat.worker = undefined;
  heartbeat.shared = undefined;
  heartbeat.completion = undefined;
});

const leaseMs = 60_000;
const commitMs = leaseMs + 1_000;

function advanceDuringCommit() {
  const completion = heartbeat.completion!;
  const before = Atomics.load(completion, 0);
  heartbeat.now += commitMs;
  heartbeat.worker!.postMessage({ fixtureAdvance: commitMs }, []);
  // Wait for an event, not elapsed time: the real worker must finish its due renewal.
  expect(Atomics.wait(completion, 0, before, 5_000)).not.toBe("timed-out");
  expect(Atomics.load(completion, 0)).toBe(before + 1);
}

describe("agent maintenance native commit lease", () => {
  it.for(["commit", "owner replaced", "grant replaced", "rollback"] as const)(
    "%s after the state fence outlasts the lease",
    async (outcome, { signal }) => {
      await withOpenClawTestState({ label: "agent-leasehold" }, async (state) => {
        const shared = openOpenClawStateDatabase({ env: state.env });
        const pathname = path.join(state.agentDir("keeper"), "openclaw-agent.sqlite");
        fs.mkdirSync(path.dirname(pathname), { recursive: true });
        using database = openNodeSqliteDatabase(pathname);
        database.exec(
          fs.readFileSync(
            new URL("../../test/fixtures/sqlite/openclaw-agent-v2026.9.9.sql", import.meta.url),
            "utf8",
          ),
        );
        heartbeat.now = Date.now();
        vi.spyOn(Date, "now").mockImplementation(() => heartbeat.now);
        const warnings: string[] = [];
        let intercepted = false;
        let refusal: unknown;
        let rollbackSettled = false;
        const syntheticFailure = new Error("synthetic native commit failure");
        const nativeExec = database.exec.bind(database);
        vi.spyOn(database, "exec").mockImplementation((sql) => {
          if (sql.trim() !== "COMMIT" || intercepted) {
            return nativeExec(sql);
          }
          intercepted = true;
          expect(shared.db.isTransaction).toBe(true);
          advanceDuringCommit();
          expect(Atomics.load(heartbeat.shared!, leaseHeartbeatState.status)).toBe(
            leaseHeartbeatState.ready,
          );
          if (outcome === "rollback") {
            throw syntheticFailure;
          }
          nativeExec(sql);
          if (outcome === "owner replaced" || outcome === "grant replaced") {
            shared.db
              .prepare(
                outcome === "owner replaced"
                  ? "UPDATE state_leases SET owner = 'replacement' WHERE scope = ? AND lease_key = ?"
                  : "UPDATE state_leases SET created_at = created_at + 1 WHERE scope = ? AND lease_key = ?",
              )
              .run(AGENT_DATABASE_MAINTENANCE_LEASE.scope, AGENT_DATABASE_MAINTENANCE_LEASE.key);
          }
        });
        const operation = withAgentDatabaseMaintenanceLease(
          { env: state.env, leaseMs },
          async (maintenance) => {
            const lost = new Promise<void>((resolve) => {
              maintenance.signal.addEventListener("abort", () => resolve(), { once: true });
            });
            const migrate = () =>
              runSqliteIntegrityOperationInWorker(
                ensureOpenClawAgentDatabaseSchemaSteps(database, {
                  agentId: "keeper",
                  path: pathname,
                  env: state.env,
                  register: true,
                  versionMigrationOnly: true,
                  onMigrationWarning: (warning) => warnings.push(warning),
                }),
                {
                  busyTimeoutMs: 0,
                  signal: maintenance.signal,
                  beforeResume: () => maintenance.assertOwned(),
                },
              );
            if (outcome === "rollback") {
              await expect(migrate()).rejects.toBe(syntheticFailure);
              expect(Atomics.load(heartbeat.shared!, leaseHeartbeatState.ownerFence)).toBe(0n);
              await withinTest(lost, signal);
              expect(() => maintenance.assertOwned()).toThrow();
              rollbackSettled = true;
              return;
            }
            try {
              await migrate();
            } catch (error) {
              refusal = error;
              throw error;
            }
            expect(Atomics.load(heartbeat.shared!, leaseHeartbeatState.ownerFence)).toBe(0n);
            expect(Atomics.load(heartbeat.shared!, leaseHeartbeatState.status)).toBe(
              leaseHeartbeatState.ready,
            );
            expect(maintenance.signal.aborted).toBe(false);
            maintenance.assertOwned();
            const row = shared.db
              .prepare(
                "SELECT expires_at, heartbeat_at FROM state_leases WHERE scope = ? AND lease_key = ?",
              )
              .get(AGENT_DATABASE_MAINTENANCE_LEASE.scope, AGENT_DATABASE_MAINTENANCE_LEASE.key);
            expect(row).toEqual({
              expires_at: heartbeat.now + leaseMs,
              heartbeat_at: heartbeat.now,
            });
          },
        );
        if (outcome === "commit") {
          await expect(operation).resolves.toBeUndefined();
          expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(
            OPENCLAW_AGENT_SCHEMA_VERSION,
          );
          expect(warnings).toContainEqual(expect.stringContaining(String(commitMs)));
        } else {
          await expect(operation).rejects.toThrow();
        }
        expect(intercepted).toBe(true);
        if (outcome === "rollback") {
          expect(rollbackSettled).toBe(true);
          expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(24);
        } else if (outcome !== "commit") {
          expect(refusal).toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
        }
      });
    },
  );
});
