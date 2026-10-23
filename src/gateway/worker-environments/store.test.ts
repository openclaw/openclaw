import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureAgentLifecycleBinding,
  matchesAgentLifecycleBinding,
} from "../../agents/agent-lifecycle-registry.js";
import * as sqliteQueries from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import type { WorkerSshEndpoint } from "../../plugins/types.js";
import { recordAgentProvenance } from "../../state/agent-provenance.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../../state/openclaw-state-db-readonly.js";
import {
  assertOpenClawStateDatabaseForMaintenance,
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { hashWorkerCredential } from "./credential.js";
import { createEnvironmentStoreFixture } from "./placement-test-fixtures.js";
import { findWorkerEnvironment, listRows } from "./store-row-codec.js";
import { ensureWorkerEnvironmentStoreSchema } from "./store-schema.js";
import { createWorkerEnvironmentStore, type WorkerEnvironmentStore } from "./store.js";

describe("worker environment store", () => {
  const tempDirs = useStateDatabaseTempDirs();
  let root: string;
  let database: OpenClawStateDatabase;
  let store: WorkerEnvironmentStore;
  let nowMs: number;
  const {
    hostKey: HOST_KEY,
    sshEndpoint: SSH_ENDPOINT,
    bootstrapReceipt: BOOTSTRAP_RECEIPT,
    credential: CREDENTIAL,
    createIntent,
    fallbackPortRows,
    seedBootstrapping,
    readyPatch,
    attachedPatch,
  } = createEnvironmentStoreFixture({
    getStore: () => store,
    getDatabase: () => database,
    now: () => nowMs,
  });

  beforeEach(async () => {
    root = tempDirs.make("openclaw-worker-env-");
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    nowMs = 1_000;
    store = await createWorkerEnvironmentStore({ database, now: () => nowMs });
  });

  async function reopen() {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = await createWorkerEnvironmentStore({ database, now: () => nowMs });
  }

  type Transition = Parameters<WorkerEnvironmentStore["transition"]>[0];
  const move = (
    environmentId: string,
    from: Transition["from"],
    to: Transition["to"],
    patch?: Transition["patch"],
    expectedOwnerEpoch?: number,
  ) => store.transition({ environmentId, from, to, patch, expectedOwnerEpoch });
  const makeReady = async (environmentId: string, leaseId: string) => {
    const bootstrapping = await seedBootstrapping(environmentId, leaseId);
    return move(environmentId, bootstrapping.state, "ready", readyPatch());
  };
  const attach = (
    { environmentId, state }: Awaited<ReturnType<typeof makeReady>>,
    sessionId: string,
  ) => move(environmentId, state, "attached", attachedPatch(sessionId, environmentId));

  it("revalidates agent incarnation inside worker admission without joining its writer lock", async () => {
    const options = { path: database.path };
    const config = { agents: { entries: { worker: {} } } };
    const binding = await captureAgentLifecycleBinding(() => config, "worker", options);
    expect(binding).toBeDefined();
    const assertCurrent = () => {
      if (!binding || !matchesAgentLifecycleBinding(config, binding, options)) {
        throw new Error("Agent incarnation changed");
      }
    };
    const create = (environmentId: string) =>
      store.createIntent(
        {
          environmentId,
          providerId: "fake-provider",
          profileId: "test-profile",
          profileSnapshot: { settings: {} },
          provisionOperationId: `provision:${environmentId}`,
        },
        assertCurrent,
      );

    await expect(create("live-agent")).resolves.toMatchObject({ state: "requested" });
    await withOpenClawStateDatabaseReadSnapshot(async () => {
      await recordAgentProvenance("worker", { createdVia: "operator" }, { ...options, nowMs: 42 });
      await expect(create("replaced-agent")).rejects.toThrow("Agent incarnation changed");
    }, options);
    expect(store.get("replaced-agent")).toBeUndefined();
  });

  it("replaces and reopens ten ordered SSH fallback rows", async () => {
    const environmentId = "worker-endpoint-change";
    const fallbackPorts = Array.from({ length: 10 }, (_, index) => 2310 - index);
    await seedBootstrapping("worker-unrelated", "lease-unrelated");
    await seedBootstrapping(environmentId, "lease-endpoint-change");
    nowMs = 900;
    await createIntent("worker-without-ports");
    nowMs = 1_000;
    const expected: WorkerSshEndpoint = { ...SSH_ENDPOINT, fallbackPorts };

    const updated = await move(environmentId, "bootstrapping", "ready", {
      ...readyPatch(),
      sshEndpoint: expected,
    });
    expect(updated.sshEndpoint).toStrictEqual(expected);
    expect(fallbackPortRows(environmentId)).toEqual(
      fallbackPorts.map((port, position) => ({ position, port })),
    );

    await reopen();
    expect(store.get(environmentId)?.sshEndpoint).toStrictEqual(expected);
    const expectedRecords = [
      ["worker-without-ports", null],
      [environmentId, expected],
      ["worker-unrelated", SSH_ENDPOINT],
    ];
    for (const records of [store.list(), store.listForReconcile()]) {
      expect(records.map((record) => [record.environmentId, record.sshEndpoint])).toEqual(
        expectedRecords,
      );
    }
    using queries = vi.spyOn(sqliteQueries, "executeSqliteQuerySync");
    expect(findWorkerEnvironment(database.db, environmentId)?.sshEndpoint).toStrictEqual(expected);
    expect(queries).toHaveBeenCalledTimes(1);
    queries.mockClear();
    expect(
      listRows(database.db).map((record) => [record.environmentId, record.sshEndpoint]),
    ).toEqual(expectedRecords);
    expect(queries).toHaveBeenCalledTimes(1);
  });

  it("rejects an unsafe persisted fallback port for an SSH environment", async () => {
    const port = 9_007_199_254_740_993n;
    await seedBootstrapping("worker-invalid-port", "lease-invalid-port");
    // Simulate damaged stored values while leaving the real decoder and endpoint validation active.
    database.db.exec("PRAGMA ignore_check_constraints = ON");
    try {
      const sql = "UPDATE worker_environment_ssh_fallback_ports SET port = ? WHERE position = 0";
      database.db.prepare(sql).run(port);
    } finally {
      database.db.exec("PRAGMA ignore_check_constraints = OFF");
    }
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await expect(createWorkerEnvironmentStore({ database, now: () => nowMs })).rejects.toThrow(
      /SSH fallback ports|CHECK constraint failed in worker_environment_ssh_fallback_ports/u,
    );
  });

  it("lazily ensures the companion table once for a current database", async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    const current = openNodeSqliteDatabase(database.path);
    current.exec("DROP TABLE worker_environment_ssh_fallback_ports;");
    current.close();

    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const table = () =>
      database.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("worker_environment_ssh_fallback_ports");
    expect(table()).toBeUndefined();
    expect(database.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });

    using exec = vi.spyOn(database.db, "exec");
    expect(() =>
      runOpenClawStateWriteTransaction(
        () => {
          ensureWorkerEnvironmentStoreSchema(database);
          throw new Error("refused environment mutation");
        },
        { database },
      ),
    ).toThrow("refused environment mutation");
    expect(exec.mock.calls.filter(([sql]) => /\b(?:SAVEPOINT|RELEASE)\b/i.test(sql))).toEqual([]);
    expect(table()).toBeUndefined();
    runOpenClawStateWriteTransaction(() => ensureWorkerEnvironmentStoreSchema(database), {
      database,
    });
    expect(table()).toEqual({ name: "worker_environment_ssh_fallback_ports" });

    store = await createWorkerEnvironmentStore({ database, now: () => nowMs });
    await createWorkerEnvironmentStore({ database, now: () => nowMs });
    expect(table()).toEqual({ name: "worker_environment_ssh_fallback_ports" });
    expect(() =>
      assertOpenClawStateDatabaseForMaintenance(database.db, {
        pathname: database.path,
      }),
    ).not.toThrow();
  });

  it("keeps renewal on one owner epoch and fences session replacement", async () => {
    await makeReady("worker-owner", "lease-owner");
    expect(store.get("worker-owner")?.ownerEpoch).toBe(1);
    expect(store.getCredential("worker-owner")).toMatchObject({ ownerEpoch: 1, sessionId: null });

    await reopen();
    const renewal = [CREDENTIAL, "renewal"].join("-");
    const renew = (credential: string, sessionId: string | null) =>
      store.renewCredential({
        environmentId: "worker-owner",
        expectedOwnerEpoch: 1,
        credentialHash: hashWorkerCredential(credential),
        sessionId,
        rpcSetVersion: 1,
        expiresAtMs: nowMs + 20_000,
      });
    expect(await renew(renewal, null)).toMatchObject({
      ownerEpoch: 1,
      credentialHash: hashWorkerCredential(renewal),
    });
    expect(store.get("worker-owner")?.ownerEpoch).toBe(1);

    const attached = await move(
      "worker-owner",
      "ready",
      "attached",
      attachedPatch("session-1", "session"),
      1,
    );
    expect(attached.ownerEpoch).toBe(2);
    expect(store.getCredential("worker-owner")).toMatchObject({
      ownerEpoch: 2,
      sessionId: "session-1",
      deliveredAtMs: null,
    });
    await expect(renew([renewal, "stale"].join("-"), "session-1")).rejects.toThrow(
      "owner epoch changed",
    );
  });

  it("allocates globally distinct owner epochs when a session moves environments", async () => {
    const firstReady = await makeReady("worker-owner-a", "lease-owner-a");
    const first = await attach(firstReady, "shared-session");
    const secondReady = await makeReady("worker-owner-b", "lease-owner-b");
    await expect(attach(secondReady, "shared-session")).rejects.toThrow(
      "already attached to worker environment worker-owner-a",
    );
    await move(first.environmentId, first.state, "idle");
    database.db
      .prepare(
        `INSERT INTO worker_transcript_commit_heads (
          session_id, run_epoch, environment_id, next_seq, updated_at_ms
        ) VALUES (?, ?, ?, 1, ?)`,
      )
      .run("shared-session", first.ownerEpoch, first.environmentId, nowMs);
    database.db
      .prepare("DELETE FROM worker_environments WHERE environment_id = ?")
      .run(first.environmentId);
    const second = await attach(secondReady, "shared-session");

    expect(first.ownerEpoch).toBe(2);
    expect(second.ownerEpoch).toBeGreaterThan(first.ownerEpoch);
  });

  it("rejects illegal, stale, and lease-incomplete transitions", async () => {
    const transition = (
      from: Transition["from"],
      to: Transition["to"],
      patch?: Transition["patch"],
    ) => move("worker-1", from, to, patch);
    const rejects = (error: string, ...input: Parameters<typeof transition>) =>
      expect(transition(...input)).rejects.toThrow(error);
    await createIntent();
    await rejects("Illegal worker environment transition", "requested", "ready");
    await transition("requested", "provisioning");
    await rejects("state conflict", "requested", "provisioning");
    await rejects("requires a provider lease", "provisioning", "bootstrapping");
    await rejects("requires an SSH endpoint reference", "provisioning", "bootstrapping", {
      leaseId: "lease-1",
    });
    await rejects("requires bootstrap proof or a node lease", "provisioning", "ready", {
      leaseId: "lease-1",
      sshEndpoint: SSH_ENDPOINT,
    });
    await transition("provisioning", "bootstrapping", {
      leaseId: "lease-1",
      sshEndpoint: SSH_ENDPOINT,
    });
    await rejects("requires a bootstrap receipt", "bootstrapping", "ready");
    await rejects("lease id is immutable", "bootstrapping", "ready", {
      leaseId: "different-lease",
    });
  });

  it("enforces one credential-bound session and teardown fencing", async () => {
    const { environmentId, state } = await seedBootstrapping(
      "worker-multi-session",
      "lease-multi-session",
    );
    const ready = readyPatch();
    await expect(
      move(environmentId, "bootstrapping", "ready", {
        ...ready,
        credential: { ...ready.credential, sessionId: "session-1" },
      }),
    ).rejects.toThrow("session does not match");
    await move(environmentId, state, "ready", ready);

    await expect(
      move(environmentId, "ready", "attached", {
        ...attachedPatch("session-a", "multi"),
        attachedSessionIds: ["session-a", "session-b"],
      }),
    ).rejects.toThrow("exactly one session id");

    await store.requestDestroy({ environmentId, state: "ready" });
    await expect(
      move(environmentId, "ready", "attached", attachedPatch("session-a", "destroying")),
    ).rejects.toThrow("after destroy is requested");
  });

  it("invalidates stale receipts for rebootstrap and replaces them on readiness", async () => {
    const environmentId = "worker-rebootstrap";
    await makeReady(environmentId, "lease-rebootstrap");
    // Existing ready rows may predate bootstrap receipt persistence.
    database.db.exec(`
      UPDATE worker_environments
      SET
        bootstrap_bundle_hash = NULL,
        bootstrap_openclaw_version = NULL,
        bootstrap_protocol_features_json = NULL
      WHERE environment_id = 'worker-rebootstrap';
    `);
    await reopen();
    expect(store.get(environmentId)).toMatchObject({
      state: "ready",
      bootstrapReceipt: null,
    });
    const beforeAttach = store.get(environmentId);
    await expect(
      move(
        environmentId,
        "ready",
        "attached",
        attachedPatch("session-1", "legacy"),
        beforeAttach?.ownerEpoch,
      ),
    ).rejects.toThrow("requires bootstrap proof");
    expect(store.get(environmentId)).toMatchObject({
      state: "ready",
      ownerEpoch: beforeAttach?.ownerEpoch,
      attachedSessionIds: [],
    });
    const idle = await move(environmentId, "ready", "idle");
    const bootstrapping = await move(environmentId, idle.state, "bootstrapping");
    expect(bootstrapping).toMatchObject({
      state: "bootstrapping",
      bootstrapReceipt: null,
      leaseId: "lease-rebootstrap",
    });

    const nextReceipt = { ...BOOTSTRAP_RECEIPT, bundleHash: "b".repeat(64) };
    expect(
      await move(environmentId, "bootstrapping", "ready", readyPatch(nextReceipt)),
    ).toMatchObject({
      state: "ready",
      bootstrapReceipt: {
        ...nextReceipt,
        protocolFeatures: ["model-proxy-v1", "workspace-sync-v1"],
      },
    });
  });

  it("requires provider teardown proof before terminal bootstrap failure", async () => {
    await seedBootstrapping("worker-bootstrap-failed", "lease-bootstrap-failed");

    await expect(
      move("worker-bootstrap-failed", "bootstrapping", "failed", {
        lastError: "node runtime missing",
      }),
    ).rejects.toThrow("Illegal worker environment transition");

    let unrequested = await seedBootstrapping(
      "worker-bootstrap-unrequested",
      "lease-bootstrap-unrequested",
    );
    unrequested = await move(unrequested.environmentId, unrequested.state, "draining");
    unrequested = await move(unrequested.environmentId, unrequested.state, "destroying");
    await expect(
      move(unrequested.environmentId, unrequested.state, "failed", {
        leaseId: null,
        sshEndpoint: null,
        lastError: "node runtime missing",
      }),
    ).rejects.toThrow("requires durable provider teardown intent");

    const pending = await seedBootstrapping("worker-bootstrap-cleanup", "lease-bootstrap-cleanup");
    const requested = await store.requestDestroy({
      environmentId: pending.environmentId,
      state: pending.state,
      terminalState: "failed",
    });
    const draining = await move(pending.environmentId, requested.state, "draining");
    const destroying = await move(pending.environmentId, draining.state, "destroying");
    expect(destroying.teardownTerminalState).toBe("failed");
    expect(
      await move(pending.environmentId, destroying.state, "failed", {
        leaseId: null,
        sshEndpoint: null,
        lastError: "node runtime missing; provider teardown completed",
      }),
    ).toMatchObject({
      state: "failed",
      leaseId: null,
      teardownTerminalState: "failed",
    });
    expect(store.get(pending.environmentId)?.sshEndpoint).toBeNull();
    expect(fallbackPortRows(pending.environmentId)).toEqual([]);
  });

  it("accepts only SecretRef metadata for persisted SSH keys", async () => {
    await createIntent();
    await move("worker-1", "requested", "provisioning");
    const plaintextEndpoint = {
      ...SSH_ENDPOINT,
      keyRef: "plaintext-private-key",
    } as unknown as WorkerSshEndpoint;
    const noncanonicalEndpoint = {
      ...SSH_ENDPOINT,
      keyRef: { source: "file", provider: "worker-keys", id: "private-key" },
    } as WorkerSshEndpoint;

    for (const sshEndpoint of [plaintextEndpoint, noncanonicalEndpoint]) {
      await expect(
        move("worker-1", "provisioning", "bootstrapping", { leaseId: "lease-1", sshEndpoint }),
      ).rejects.toThrow("SSH key must be a valid SecretRef");
    }
  });

  it.each([
    ["multiple lines", `${HOST_KEY}\n${HOST_KEY}`],
    ["extra fields", [HOST_KEY, "comment"].join(" ")],
  ])("rejects %s persisted SSH host-key material", async (_label, hostKey) => {
    await createIntent();
    await move("worker-1", "requested", "provisioning");
    const sshEndpoint = { ...SSH_ENDPOINT, hostKey } as unknown as WorkerSshEndpoint;

    await expect(
      move("worker-1", "provisioning", "bootstrapping", { leaseId: "lease-1", sshEndpoint }),
    ).rejects.toThrow("SSH host key");
  });
});
