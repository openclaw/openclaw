import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createEnvironmentStoreFixture } from "./placement-test-fixtures.js";
import {
  createWorkerEnvironmentStore,
  type WorkerEnvironmentRecord,
  type WorkerEnvironmentStore,
} from "./store.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const PRUNE_NOW_MS = 10 * DAY_MS;

const admission = vi.hoisted(() => ({ beforeCommit: undefined as (() => void) | undefined }));
vi.mock("../../infra/sqlite-worker-operation-admission.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/sqlite-worker-operation-admission.js")>();
  return {
    ...actual,
    createSqliteWorkerOperationAdmission: (
      ...[admit, attachment]: Parameters<typeof actual.createSqliteWorkerOperationAdmission>
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
  const { fallbackPortRows, seedBootstrapping, readyPatch } = createEnvironmentStoreFixture({
    getStore: () => store,
    getDatabase: () => database,
    now: () => nowMs,
  });
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

  const sql = (query: string) => database.db.prepare(query);
  const prune = (limit: number, canPruneDemand: (record: WorkerEnvironmentRecord) => boolean) =>
    store.pruneTerminalEnvironments({ nowMs: PRUNE_NOW_MS, limit, canPruneDemand });
  async function seedReady(environmentId: string) {
    nowMs = 1_000;
    const bootstrapping = await seedBootstrapping(environmentId, `lease:${environmentId}`);
    await store.transition({
      environmentId,
      from: bootstrapping.state,
      to: "ready",
      patch: readyPatch(),
    });
  }

  async function seedOrphaned(environmentId: string, stateChangedAtMs: number) {
    await seedReady(environmentId);
    nowMs = stateChangedAtMs;
    return store.transition({ environmentId, from: "ready", to: "orphaned" });
  }

  const terminalIds = (count: number) =>
    Array.from({ length: count }, (_, index) => `worker-${String(index).padStart(4, "0")}`);
  async function seedTerminalRows(ids: readonly string[], referenced = 0) {
    await seedOrphaned(ids[0]!, DAY_MS);
    // Offline fixture writes precede a fresh resident inventory admission.
    await store.close();
    const template = sql("SELECT * FROM worker_environments").get()!;
    const columns = Object.keys(template);
    const insert = sql(
      `INSERT INTO worker_environments (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    );
    const placement = sql(`INSERT INTO worker_session_placements (
      session_id, agent_id, session_key, state, environment_id, recovery_error,
      created_at_ms, updated_at_ms, state_changed_at_ms
    ) VALUES (?, 'agent-1', ?, 'failed', ?, 'worker disappeared', 1, 1, 1)`);
    runOpenClawStateWriteTransaction(
      () => {
        for (const environmentId of ids.slice(1)) {
          const row = {
            ...template,
            environment_id: environmentId,
            provision_operation_id: `provision-${environmentId}`,
            lease_id: `lease:${environmentId}`,
          };
          insert.run(...columns.map((column) => row[column as keyof typeof row]));
        }
        for (const environmentId of ids.slice(0, referenced)) {
          placement.run(`session:${environmentId}`, `key:${environmentId}`, environmentId);
        }
      },
      { database },
    );
    store = await createWorkerEnvironmentStore({ database, now: () => nowMs });
  }

  it("prunes only old unreferenced terminal environments and cascades owned rows", async () => {
    await seedOrphaned("worker-old-first", DAY_MS);
    await seedOrphaned("worker-a-old-second", 2 * DAY_MS);
    await seedOrphaned("worker-referenced", 3 * DAY_MS);
    await seedOrphaned("worker-recent", PRUNE_NOW_MS - 1_000);
    await seedReady("worker-ready");
    sql(`INSERT INTO worker_session_placements (
          session_id, agent_id, session_key, state, environment_id, recovery_error,
          created_at_ms, updated_at_ms, state_changed_at_ms
        ) VALUES ('session-referenced', 'agent-1', 'session-key-1', 'failed', ?,
          'worker environment disappeared', 1, 1, 1)`).run("worker-referenced");
    sql(`INSERT INTO worker_inference_turns (
          session_id, run_epoch, run_id, turn_id, environment_id, request_hash,
          state, terminal_json, created_at_ms, updated_at_ms
        ) VALUES ('session-old', 1, 'run-old', 'turn-old', ?, 'hash-old',
          'terminal', '{}', 1, 1)`).run("worker-old-first");
    expect(fallbackPortRows("worker-old-first")).toHaveLength(2);

    expect(await prune(1, () => true)).toBe(1);
    expect(store.get("worker-old-first")).toBeUndefined();
    expect(store.get("worker-a-old-second")?.state).toBe("orphaned");
    expect(fallbackPortRows("worker-old-first")).toEqual([]);
    expect(
      sql("SELECT environment_id FROM worker_inference_turns WHERE environment_id = ?").get(
        "worker-old-first",
      ),
    ).toBeUndefined();

    expect(await prune(10, () => true)).toBe(1);
    expect(store.get("worker-a-old-second")).toBeUndefined();
    expect(store.get("worker-referenced")?.state).toBe("orphaned");
    expect(store.get("worker-recent")?.state).toBe("orphaned");
    expect(store.get("worker-ready")?.state).toBe("ready");
  });

  it.each(["demand", "placement"] as const)(
    "continues past a page protected by %s to delete a later eligible environment",
    async (protection) => {
      await seedTerminalRows(terminalIds(257), protection === "placement" ? 256 : 0);
      expect(
        await prune(
          1,
          (record) => protection === "placement" || record.environmentId === "worker-0256",
        ),
      ).toBe(1);
      expect(store.get("worker-0256")).toBeUndefined();
      expect(store.get("worker-0000")?.state).toBe("orphaned");
      expect(sql("SELECT count(*) AS count FROM worker_environments").get()).toEqual({
        count: 256,
      });
    },
  );

  it("keeps default and requested total limits across bounded mutation pages", async () => {
    const ids = terminalIds(600);
    await seedTerminalRows(ids);
    expect(await store.pruneTerminalEnvironments({ nowMs: PRUNE_NOW_MS })).toBe(256);
    expect(await prune(300, () => true)).toBe(300);
    expect(store.list().map((record) => record.environmentId)).toEqual(ids.slice(556));
    expect(sql("SELECT count(*) AS count FROM worker_environments").get()).toEqual({ count: 44 });
  });

  it("breaks equal-age ties in database UTF-8 order", async () => {
    await seedTerminalRows(["worker-\u{10000}", "worker-\ue000"]);
    expect(await prune(1, () => true)).toBe(1);
    expect(store.get("worker-\ue000")).toBeUndefined();
    expect(store.get("worker-\u{10000}")?.state).toBe("orphaned");
  });

  it.each(["veto", "error"] as const)(
    "preserves earlier committed pages after a later demand %s",
    async (outcome) => {
      await seedTerminalRows(terminalIds(257));
      let commits = 0;
      let protectedDemand = false;
      const failure = new Error("later retention policy failed");
      admission.beforeCommit = () => {
        protectedDemand = ++commits === 2;
      };
      const deleting = prune(300, (record) => {
        if (protectedDemand && record.environmentId === "worker-0256") {
          if (outcome === "error") {
            throw failure;
          }
          return false;
        }
        return true;
      });
      if (outcome === "error") {
        await expect(deleting).rejects.toBe(failure);
      } else {
        expect(await deleting).toBe(256);
      }
      expect(store.list().map((record) => record.environmentId)).toEqual(["worker-0256"]);
      expect(sql("SELECT count(*) AS count FROM worker_environments").get()).toEqual({ count: 1 });
      admission.beforeCommit = undefined;
      expect(await prune(300, () => true)).toBe(1);
      expect(store.list()).toEqual([]);
    },
  );

  it("defers the batch when live demand changes at worker commit and preserves policy errors", async () => {
    await seedOrphaned("worker-retention-first", DAY_MS);
    await seedOrphaned("worker-retention-protected", 2 * DAY_MS);
    const readRows = () => sql("SELECT * FROM worker_environments ORDER BY environment_id").all();
    const before = readRows();
    let protectedDemand = false;
    let predicateError: Error | undefined;
    const canPruneDemand = (record: WorkerEnvironmentRecord) => {
      if (predicateError) {
        throw predicateError;
      }
      return !protectedDemand || record.environmentId !== "worker-retention-protected";
    };
    admission.beforeCommit = () => {
      protectedDemand = true;
    };
    expect(await prune(2, canPruneDemand)).toBe(0);
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
    await expect(prune(2, canPruneDemand)).rejects.toBe(failure);
    expect(readRows()).toEqual(before);

    admission.beforeCommit = undefined;
    predicateError = undefined;
    expect(await prune(2, canPruneDemand)).toBe(2);
    expect(store.list()).toEqual([]);
  });
});
