import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { WorkerProfile, WorkerSshEndpoint } from "../../plugins/types.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { hashWorkerCredential } from "./credential.js";
import {
  createWorkerEnvironmentStore,
  type WorkerEnvironmentRecord,
  type WorkerEnvironmentStore,
} from "./store.js";

type WorkerEnvironmentBootstrapReceipt = WorkerAdmissionHandshake & {
  installKind?: "bundle" | "local";
};
type WorkerEnvironmentProfileSnapshot = WorkerProfile;
type WorkerEnvironmentSshEndpoint = WorkerSshEndpoint;

const HOST_KEY = ["ssh-ed25519", "AAAA"].join(" ");
const SSH_ENDPOINT: WorkerEnvironmentSshEndpoint = {
  host: "worker.example.test",
  port: 2222,
  fallbackPorts: [22, 2200],
  user: "openclaw",
  hostKey: HOST_KEY,
  keyRef: {
    source: "file",
    provider: "worker-keys",
    id: "/static-development-key",
  },
};
const BOOTSTRAP_RECEIPT: WorkerEnvironmentBootstrapReceipt = {
  bundleHash: "a".repeat(64),
  openclawVersion: "2026.7.1",
  protocolFeatures: ["workspace-sync-v1", "model-proxy-v1"],
};
const CREDENTIAL = ["worker", "credential", "fixture"].join("-");
const DAY_MS = 24 * 60 * 60 * 1_000;
const PRUNE_NOW_MS = 10 * DAY_MS;

const admission = vi.hoisted(() => ({ beforeCommit: undefined as (() => void) | undefined }));
vi.mock("../../infra/sqlite-worker-operation-admission.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/sqlite-worker-operation-admission.js")>();
  return {
    ...actual,
    createSqliteWorkerOperationAdmission: (
      admit: Parameters<typeof actual.createSqliteWorkerOperationAdmission>[0],
      attachment?: Parameters<typeof actual.createSqliteWorkerOperationAdmission>[1],
    ) =>
      actual.createSqliteWorkerOperationAdmission((request, grant) => {
        if (request.stage === "commit") {
          admission.beforeCommit?.();
        }
        admit(request, grant);
      }, attachment),
  };
});

describe("worker environment terminal retention", () => {
  let database: OpenClawStateDatabase;
  let store: WorkerEnvironmentStore;
  let nowMs: number;
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      admission.beforeCommit = undefined;
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    }),
  );

  beforeEach(async () => {
    const root = tempDirs.make("openclaw-worker-env-retention-");
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    nowMs = 1_000;
    store = await createWorkerEnvironmentStore({ database, now: () => nowMs });
  });

  function createIntent(
    environmentId = "worker-1",
    profileSnapshot: WorkerEnvironmentProfileSnapshot = {
      settings: { region: "test" },
      lifetime: { idleMinutes: 10 },
    },
  ) {
    return store.createIntent({
      environmentId,
      providerId: "fake-provider",
      profileId: "test-profile",
      profileSnapshot,
      provisionOperationId: `provision:${environmentId}`,
    });
  }

  function fallbackPortRows(environmentId: string) {
    return database.db
      .prepare(
        `SELECT position, port
         FROM worker_environment_ssh_fallback_ports
         WHERE environment_id = ?
         ORDER BY position`,
      )
      .all(environmentId);
  }

  async function seedBootstrapping(environmentId: string, leaseId: string) {
    await createIntent(environmentId);
    await store.transition({ environmentId, from: "requested", to: "provisioning" });
    return store.transition({
      environmentId,
      from: "provisioning",
      to: "bootstrapping",
      patch: { leaseId, sshEndpoint: SSH_ENDPOINT },
    });
  }

  async function seedOrphaned(environmentId: string, stateChangedAtMs: number) {
    nowMs = 1_000;
    const bootstrapping = await seedBootstrapping(environmentId, `lease:${environmentId}`);
    await store.transition({
      environmentId,
      from: bootstrapping.state,
      to: "ready",
      patch: readyPatch(),
    });
    nowMs = stateChangedAtMs;
    return store.transition({ environmentId, from: "ready", to: "orphaned" });
  }

  function readyPatch(receipt = BOOTSTRAP_RECEIPT) {
    return {
      bootstrapReceipt: receipt,
      credential: {
        credentialHash: hashWorkerCredential(CREDENTIAL),
        sessionId: null,
        rpcSetVersion: 1,
        expiresAtMs: nowMs + 10_000,
      },
    };
  }

  it("uses the terminal environment index for ordered cleanup", () => {
    const plan = database.db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT worker_environments.environment_id
         FROM worker_environments
         LEFT JOIN worker_session_placements
           ON worker_session_placements.environment_id = worker_environments.environment_id
         WHERE worker_environments.state IN ('destroyed', 'failed', 'orphaned')
           AND worker_environments.state_changed_at_ms <= ?
           AND worker_session_placements.session_id IS NULL
         ORDER BY worker_environments.state_changed_at_ms ASC,
                  worker_environments.environment_id ASC
         LIMIT ?`,
      )
      .all(PRUNE_NOW_MS - 7 * DAY_MS, 2) as Array<{ detail: string }>;

    expect(plan.map((row) => row.detail).join("\n")).toContain(
      "idx_worker_environments_terminal_changed",
    );
    expect(plan.map((row) => row.detail).join("\n")).toContain(
      "idx_worker_session_placements_environment",
    );
  });

  it("prunes only old unreferenced terminal environments and cascades owned rows", async () => {
    await seedOrphaned("worker-old-first", DAY_MS);
    await seedOrphaned("worker-a-old-second", 2 * DAY_MS);
    await seedOrphaned("worker-referenced", 3 * DAY_MS);
    await seedOrphaned("worker-recent", PRUNE_NOW_MS - 1_000);
    nowMs = 1_000;
    const ready = await seedBootstrapping("worker-ready", "lease:worker-ready");
    await store.transition({
      environmentId: ready.environmentId,
      from: ready.state,
      to: "ready",
      patch: readyPatch(),
    });
    database.db
      .prepare(
        `INSERT INTO worker_session_placements (
          session_id, agent_id, session_key, state, environment_id, recovery_error,
          created_at_ms, updated_at_ms, state_changed_at_ms
        ) VALUES ('session-referenced', 'agent-1', 'session-key-1', 'failed', ?,
          'worker environment disappeared', 1, 1, 1)`,
      )
      .run("worker-referenced");
    database.db
      .prepare(
        `INSERT INTO worker_inference_turns (
          session_id, run_epoch, run_id, turn_id, environment_id, request_hash,
          state, terminal_json, created_at_ms, updated_at_ms
        ) VALUES ('session-old', 1, 'run-old', 'turn-old', ?, 'hash-old',
          'terminal', '{}', 1, 1)`,
      )
      .run("worker-old-first");
    expect(fallbackPortRows("worker-old-first")).toHaveLength(2);

    const policyVisits: string[] = [];
    const canPruneDemand = (record: WorkerEnvironmentRecord) => {
      policyVisits.push(record.environmentId);
      expect(record.sshEndpoint?.fallbackPorts).toBeUndefined();
      return true;
    };
    expect(
      await store.pruneTerminalEnvironments({ nowMs: PRUNE_NOW_MS, limit: 1, canPruneDemand }),
    ).toBe(1);
    expect(new Set(policyVisits)).toEqual(new Set(["worker-old-first"]));
    expect(store.get("worker-old-first")).toBeUndefined();
    expect(fallbackPortRows("worker-old-first")).toEqual([]);
    expect(
      database.db
        .prepare("SELECT environment_id FROM worker_inference_turns WHERE environment_id = ?")
        .get("worker-old-first"),
    ).toBeUndefined();

    policyVisits.length = 0;
    expect(
      await store.pruneTerminalEnvironments({ nowMs: PRUNE_NOW_MS, limit: 10, canPruneDemand }),
    ).toBe(1);
    expect(new Set(policyVisits)).toEqual(new Set(["worker-a-old-second"]));
    expect(store.get("worker-a-old-second")).toBeUndefined();
    expect(store.get("worker-referenced")?.state).toBe("orphaned");
    expect(store.get("worker-recent")?.state).toBe("orphaned");
    expect(store.get("worker-ready")?.state).toBe("ready");
  });

  it("continues past a retained prune page before selecting a later eligible environment", async () => {
    await seedOrphaned("worker-0000", DAY_MS);
    const template = database.db.prepare("SELECT * FROM worker_environments").get()!;
    const columns = Object.keys(template);
    const insert = database.db.prepare(
      `INSERT INTO worker_environments (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    );
    runOpenClawStateWriteTransaction(
      () => {
        for (let index = 1; index <= 256; index += 1) {
          const suffix = String(index).padStart(4, "0");
          const row = {
            ...template,
            environment_id: `worker-${suffix}`,
            provision_operation_id: `provision-${suffix}`,
            lease_id: `lease:worker-${suffix}`,
          };
          insert.run(...columns.map((column) => row[column as keyof typeof row]));
        }
      },
      { database },
    );
    const visited: string[] = [];
    expect(
      await store.pruneTerminalEnvironments({
        nowMs: PRUNE_NOW_MS,
        limit: 1,
        canPruneDemand: (record) => {
          visited.push(record.environmentId);
          return record.environmentId === "worker-0256";
        },
      }),
    ).toBe(1);
    expect(visited.slice(0, 257)).toEqual(
      Array.from({ length: 257 }, (_, index) => `worker-${String(index).padStart(4, "0")}`),
    );
    expect(visited.slice(257).every((id) => id === "worker-0256")).toBe(true);
    expect(database.db.prepare("SELECT count(*) AS count FROM worker_environments").get()).toEqual({
      count: 256,
    });
  });

  it("defers the batch when live demand changes at worker commit and preserves policy errors", async () => {
    await seedOrphaned("worker-retention-first", DAY_MS);
    await seedOrphaned("worker-retention-protected", 2 * DAY_MS);
    const readRows = () =>
      database.db.prepare("SELECT * FROM worker_environments ORDER BY environment_id").all();
    const before = readRows();
    let protectedDemand = false;
    let predicateError: Error | undefined;
    const canPruneDemand = (record: WorkerEnvironmentRecord) => {
      if (predicateError) {
        throw predicateError;
      }
      return !protectedDemand || record.environmentId !== "worker-retention-protected";
    };
    const prune = () =>
      store.pruneTerminalEnvironments({ nowMs: PRUNE_NOW_MS, limit: 2, canPruneDemand });
    admission.beforeCommit = () => {
      protectedDemand = true;
    };
    expect(await prune()).toBe(0);
    expect(protectedDemand).toBe(true);
    expect(readRows()).toEqual(before);
    expect(store.list().map((record) => record.environmentId)).toEqual([
      "worker-retention-first",
      "worker-retention-protected",
    ]);

    protectedDemand = false;
    const failure = new Error("retention provider unavailable");
    admission.beforeCommit = () => {
      predicateError = failure;
    };
    await expect(prune()).rejects.toBe(failure);
    expect(readRows()).toEqual(before);

    admission.beforeCommit = undefined;
    predicateError = undefined;
    expect(await prune()).toBe(2);
    expect(store.list()).toEqual([]);
  });
});
