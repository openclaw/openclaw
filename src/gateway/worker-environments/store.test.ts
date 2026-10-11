import { beforeEach, describe, expect, it } from "vitest";
import {
  captureAgentLifecycleBinding,
  matchesAgentLifecycleBinding,
} from "../../agents/agent-lifecycle-registry.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import type { WorkerSshEndpoint as WorkerEnvironmentSshEndpoint } from "../../plugins/types.js";
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

  it.each([{ name: "ten", fallbackPorts: Array.from({ length: 10 }, (_, index) => 2310 - index) }])(
    "replaces and reopens ordered SSH fallback rows ($name)",
    async ({ fallbackPorts }) => {
      await seedBootstrapping("worker-unrelated", "lease-unrelated");
      await seedBootstrapping("worker-endpoint-change", "lease-endpoint-change");
      const replacement = { ...SSH_ENDPOINT, fallbackPorts };
      const expected: WorkerEnvironmentSshEndpoint = { ...replacement };
      if (fallbackPorts.length === 0) {
        delete expected.fallbackPorts;
      }

      expect(
        (
          await store.transition({
            environmentId: "worker-endpoint-change",
            from: "bootstrapping",
            to: "ready",
            patch: { ...readyPatch(), sshEndpoint: replacement },
          })
        ).sshEndpoint,
      ).toStrictEqual(expected);
      expect(fallbackPortRows("worker-endpoint-change")).toEqual(
        fallbackPorts.map((port, position) => ({ position, port })),
      );

      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
      store = await createWorkerEnvironmentStore({ database, now: () => nowMs });
      expect(store.get("worker-endpoint-change")?.sshEndpoint).toStrictEqual(expected);
      for (const records of [store.list(), store.listForReconcile()]) {
        expect(records.map((record) => [record.environmentId, record.sshEndpoint])).toEqual([
          ["worker-endpoint-change", expected],
          ["worker-unrelated", SSH_ENDPOINT],
        ]);
      }
    },
  );

  it.each([9_007_199_254_740_993n])(
    "rejects invalid persisted fallback port %s for an SSH environment",
    async (port) => {
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
    },
  );

  it("lazily ensures the companion table once for a current database", async () => {
    const databasePath = database.path;
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const current = new DatabaseSync(databasePath);
    current.exec("DROP TABLE worker_environment_ssh_fallback_ports;");
    current.close();

    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    expect(
      database.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("worker_environment_ssh_fallback_ports"),
    ).toBeUndefined();
    expect(database.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });

    expect(() =>
      runOpenClawStateWriteTransaction(
        () => {
          ensureWorkerEnvironmentStoreSchema(database);
          throw new Error("refused environment mutation");
        },
        { database },
      ),
    ).toThrow("refused environment mutation");
    expect(
      database.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("worker_environment_ssh_fallback_ports"),
    ).toBeUndefined();
    ensureWorkerEnvironmentStoreSchema(database);
    expect(
      database.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("worker_environment_ssh_fallback_ports"),
    ).toEqual({ name: "worker_environment_ssh_fallback_ports" });

    store = await createWorkerEnvironmentStore({ database, now: () => nowMs });
    await createWorkerEnvironmentStore({ database, now: () => nowMs });
    expect(
      database.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("worker_environment_ssh_fallback_ports"),
    ).toEqual({ name: "worker_environment_ssh_fallback_ports" });
    expect(() =>
      assertOpenClawStateDatabaseForMaintenance(database.db, {
        pathname: database.path,
      }),
    ).not.toThrow();
  });

  it("keeps renewal on one owner epoch and fences session replacement", async () => {
    const bootstrapping = await seedBootstrapping("worker-owner", "lease-owner");
    await store.transition({
      environmentId: bootstrapping.environmentId,
      from: bootstrapping.state,
      to: "ready",
      patch: readyPatch(),
    });
    expect(store.get("worker-owner")?.ownerEpoch).toBe(1);
    expect(store.getCredential("worker-owner")).toMatchObject({ ownerEpoch: 1, sessionId: null });

    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = await createWorkerEnvironmentStore({ database, now: () => nowMs });
    const renewal = [CREDENTIAL, "renewal"].join("-");
    expect(
      await store.renewCredential({
        environmentId: "worker-owner",
        expectedOwnerEpoch: 1,
        credentialHash: hashWorkerCredential(renewal),
        sessionId: null,
        rpcSetVersion: 1,
        expiresAtMs: nowMs + 20_000,
      }),
    ).toMatchObject({ ownerEpoch: 1, credentialHash: hashWorkerCredential(renewal) });
    expect(store.get("worker-owner")?.ownerEpoch).toBe(1);

    const attached = await store.transition({
      environmentId: "worker-owner",
      from: "ready",
      to: "attached",
      expectedOwnerEpoch: 1,
      patch: attachedPatch("session-1", "session"),
    });
    expect(attached.ownerEpoch).toBe(2);
    expect(store.getCredential("worker-owner")).toMatchObject({
      ownerEpoch: 2,
      sessionId: "session-1",
      deliveredAtMs: null,
    });
    await expect(
      store.renewCredential({
        environmentId: "worker-owner",
        expectedOwnerEpoch: 1,
        credentialHash: hashWorkerCredential([renewal, "stale"].join("-")),
        sessionId: "session-1",
        rpcSetVersion: 1,
        expiresAtMs: nowMs + 20_000,
      }),
    ).rejects.toThrow("owner epoch changed");
  });

  it("allocates globally distinct owner epochs when a session moves environments", async () => {
    const makeReady = async (environmentId: string, leaseId: string) => {
      const bootstrapping = await seedBootstrapping(environmentId, leaseId);
      return store.transition({
        environmentId,
        from: bootstrapping.state,
        to: "ready",
        patch: readyPatch(),
      });
    };

    const firstReady = await makeReady("worker-owner-a", "lease-owner-a");
    const first = await store.transition({
      environmentId: firstReady.environmentId,
      from: firstReady.state,
      to: "attached",
      patch: attachedPatch("shared-session", firstReady.environmentId),
    });
    const secondReady = await makeReady("worker-owner-b", "lease-owner-b");
    await expect(
      store.transition({
        environmentId: secondReady.environmentId,
        from: secondReady.state,
        to: "attached",
        patch: attachedPatch("shared-session", secondReady.environmentId),
      }),
    ).rejects.toThrow("already attached to worker environment worker-owner-a");
    await store.transition({
      environmentId: first.environmentId,
      from: first.state,
      to: "idle",
    });
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
    const second = await store.transition({
      environmentId: secondReady.environmentId,
      from: secondReady.state,
      to: "attached",
      patch: attachedPatch("shared-session", secondReady.environmentId),
    });

    expect(first.ownerEpoch).toBe(2);
    expect(second.ownerEpoch).toBeGreaterThan(first.ownerEpoch);
  });

  it("rejects illegal, stale, and lease-incomplete transitions", async () => {
    await createIntent();
    await expect(
      store.transition({ environmentId: "worker-1", from: "requested", to: "ready" }),
    ).rejects.toThrow("Illegal worker environment transition");

    await store.transition({ environmentId: "worker-1", from: "requested", to: "provisioning" });
    await expect(
      store.transition({
        environmentId: "worker-1",
        from: "requested",
        to: "provisioning",
      }),
    ).rejects.toThrow("state conflict");
    await expect(
      store.transition({
        environmentId: "worker-1",
        from: "provisioning",
        to: "bootstrapping",
      }),
    ).rejects.toThrow("requires a provider lease");
    await expect(
      store.transition({
        environmentId: "worker-1",
        from: "provisioning",
        to: "bootstrapping",
        patch: { leaseId: "lease-1" },
      }),
    ).rejects.toThrow("requires an SSH endpoint reference");
    await expect(
      store.transition({
        environmentId: "worker-1",
        from: "provisioning",
        to: "ready",
        patch: { leaseId: "lease-1", sshEndpoint: SSH_ENDPOINT },
      }),
    ).rejects.toThrow("requires bootstrap proof or a node lease");

    await store.transition({
      environmentId: "worker-1",
      from: "provisioning",
      to: "bootstrapping",
      patch: { leaseId: "lease-1", sshEndpoint: SSH_ENDPOINT },
    });
    await expect(
      store.transition({
        environmentId: "worker-1",
        from: "bootstrapping",
        to: "ready",
      }),
    ).rejects.toThrow("requires a bootstrap receipt");
    await expect(
      store.transition({
        environmentId: "worker-1",
        from: "bootstrapping",
        to: "ready",
        patch: { leaseId: "different-lease" },
      }),
    ).rejects.toThrow("lease id is immutable");
  });

  it("enforces one credential-bound session and teardown fencing", async () => {
    const bootstrapping = await seedBootstrapping("worker-multi-session", "lease-multi-session");
    const ready = readyPatch();
    await expect(
      store.transition({
        environmentId: bootstrapping.environmentId,
        from: "bootstrapping",
        to: "ready",
        patch: { ...ready, credential: { ...ready.credential, sessionId: "session-1" } },
      }),
    ).rejects.toThrow("session does not match");
    await store.transition({
      environmentId: bootstrapping.environmentId,
      from: bootstrapping.state,
      to: "ready",
      patch: ready,
    });

    await expect(
      store.transition({
        environmentId: bootstrapping.environmentId,
        from: "ready",
        to: "attached",
        patch: {
          ...attachedPatch("session-a", "multi"),
          attachedSessionIds: ["session-a", "session-b"],
        },
      }),
    ).rejects.toThrow("exactly one session id");

    await store.requestDestroy({ environmentId: bootstrapping.environmentId, state: "ready" });
    await expect(
      store.transition({
        environmentId: bootstrapping.environmentId,
        from: "ready",
        to: "attached",
        patch: attachedPatch("session-a", "destroying"),
      }),
    ).rejects.toThrow("after destroy is requested");
  });

  it("invalidates stale receipts for rebootstrap and replaces them on readiness", async () => {
    await seedBootstrapping("worker-rebootstrap", "lease-rebootstrap");
    await store.transition({
      environmentId: "worker-rebootstrap",
      from: "bootstrapping",
      to: "ready",
      patch: readyPatch(),
    });
    // Existing ready rows may predate bootstrap receipt persistence.
    database.db.exec(`
      UPDATE worker_environments
      SET
        bootstrap_bundle_hash = NULL,
        bootstrap_openclaw_version = NULL,
        bootstrap_protocol_features_json = NULL
      WHERE environment_id = 'worker-rebootstrap';
    `);
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = await createWorkerEnvironmentStore({ database, now: () => nowMs });
    expect(store.get("worker-rebootstrap")).toMatchObject({
      state: "ready",
      bootstrapReceipt: null,
    });
    const beforeAttach = store.get("worker-rebootstrap");
    await expect(
      store.transition({
        environmentId: "worker-rebootstrap",
        from: "ready",
        to: "attached",
        expectedOwnerEpoch: beforeAttach?.ownerEpoch,
        patch: attachedPatch("session-1", "legacy"),
      }),
    ).rejects.toThrow("requires bootstrap proof");
    expect(store.get("worker-rebootstrap")).toMatchObject({
      state: "ready",
      ownerEpoch: beforeAttach?.ownerEpoch,
      attachedSessionIds: [],
    });
    const idle = await store.transition({
      environmentId: "worker-rebootstrap",
      from: "ready",
      to: "idle",
    });

    const bootstrapping = await store.transition({
      environmentId: "worker-rebootstrap",
      from: idle.state,
      to: "bootstrapping",
    });
    expect(bootstrapping).toMatchObject({
      state: "bootstrapping",
      bootstrapReceipt: null,
      leaseId: "lease-rebootstrap",
    });

    const nextReceipt = { ...BOOTSTRAP_RECEIPT, bundleHash: "b".repeat(64) };
    expect(
      await store.transition({
        environmentId: "worker-rebootstrap",
        from: "bootstrapping",
        to: "ready",
        patch: readyPatch(nextReceipt),
      }),
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
      store.transition({
        environmentId: "worker-bootstrap-failed",
        from: "bootstrapping",
        to: "failed",
        patch: { lastError: "node runtime missing" },
      }),
    ).rejects.toThrow("Illegal worker environment transition");

    const unrequested = await seedBootstrapping(
      "worker-bootstrap-unrequested",
      "lease-bootstrap-unrequested",
    );
    const unrequestedDraining = await store.transition({
      environmentId: unrequested.environmentId,
      from: unrequested.state,
      to: "draining",
    });
    const unrequestedDestroying = await store.transition({
      environmentId: unrequested.environmentId,
      from: unrequestedDraining.state,
      to: "destroying",
    });
    await expect(
      store.transition({
        environmentId: unrequested.environmentId,
        from: unrequestedDestroying.state,
        to: "failed",
        patch: {
          leaseId: null,
          sshEndpoint: null,
          lastError: "node runtime missing",
        },
      }),
    ).rejects.toThrow("requires durable provider teardown intent");

    const pending = await seedBootstrapping("worker-bootstrap-cleanup", "lease-bootstrap-cleanup");
    const requested = await store.requestDestroy({
      environmentId: pending.environmentId,
      state: pending.state,
      terminalState: "failed",
    });
    const draining = await store.transition({
      environmentId: pending.environmentId,
      from: requested.state,
      to: "draining",
    });
    const destroying = await store.transition({
      environmentId: pending.environmentId,
      from: draining.state,
      to: "destroying",
    });
    expect(destroying.teardownTerminalState).toBe("failed");
    expect(
      await store.transition({
        environmentId: pending.environmentId,
        from: destroying.state,
        to: "failed",
        patch: {
          leaseId: null,
          sshEndpoint: null,
          lastError: "node runtime missing; provider teardown completed",
        },
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
    await store.transition({ environmentId: "worker-1", from: "requested", to: "provisioning" });
    const plaintextEndpoint = {
      ...SSH_ENDPOINT,
      keyRef: "plaintext-private-key",
    } as unknown as WorkerEnvironmentSshEndpoint;
    const noncanonicalEndpoint = {
      ...SSH_ENDPOINT,
      keyRef: { source: "file", provider: "worker-keys", id: "private-key" },
    } as WorkerEnvironmentSshEndpoint;

    for (const sshEndpoint of [plaintextEndpoint, noncanonicalEndpoint]) {
      await expect(
        store.transition({
          environmentId: "worker-1",
          from: "provisioning",
          to: "bootstrapping",
          patch: { leaseId: "lease-1", sshEndpoint },
        }),
      ).rejects.toThrow("SSH key must be a canonical SecretRef");
    }
  });

  it.each([
    ["multiple lines", `${HOST_KEY}\n${HOST_KEY}`],
    ["extra fields", [HOST_KEY, "comment"].join(" ")],
  ])("rejects %s persisted SSH host-key material", async (_label, hostKey) => {
    await createIntent();
    await store.transition({ environmentId: "worker-1", from: "requested", to: "provisioning" });
    const sshEndpoint = { ...SSH_ENDPOINT, hostKey } as unknown as WorkerEnvironmentSshEndpoint;

    await expect(
      store.transition({
        environmentId: "worker-1",
        from: "provisioning",
        to: "bootstrapping",
        patch: { leaseId: "lease-1", sshEndpoint },
      }),
    ).rejects.toThrow("SSH host key");
  });
});
