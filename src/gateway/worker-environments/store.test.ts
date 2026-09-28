import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  captureAgentLifecycleBinding,
  matchesAgentLifecycleBinding,
} from "../../agents/agent-lifecycle-registry.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import type {
  WorkerDesktopEndpoint,
  WorkerProfile,
  WorkerSshEndpoint,
} from "../../plugins/types.js";
import { recordAgentProvenance } from "../../state/agent-provenance.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../../state/openclaw-state-db-readonly.js";
import { ensureAdditiveStateColumns } from "../../state/openclaw-state-db-schema-additive.js";
import {
  assertOpenClawStateDatabaseForMaintenance,
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { hashWorkerCredential } from "./credential.js";
import { ensureWorkerEnvironmentStoreSchema } from "./store-schema.js";
import { createWorkerEnvironmentStore, type WorkerEnvironmentStore } from "./store.js";

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
const DESKTOP: WorkerDesktopEndpoint = {
  protocol: "rfb",
  port: 5900,
  passwordFilePath: "/var/lib/crabbox/vnc.password",
  username: "worker",
  apps: [
    {
      id: "browser",
      executablePath: "/usr/local/bin/openclaw-worker-browser",
      args: ["--profile", "lease profile"],
      cdpPort: 9222,
    },
    { id: "terminal", executablePath: "/usr/local/bin/openclaw-worker-terminal" },
  ],
};
const BOOTSTRAP_RECEIPT: WorkerEnvironmentBootstrapReceipt = {
  bundleHash: "a".repeat(64),
  openclawVersion: "2026.7.1",
  protocolFeatures: ["workspace-sync-v1", "model-proxy-v1"],
};
const CREDENTIAL = ["worker", "credential", "fixture"].join("-");

describe("worker environment store", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let store: WorkerEnvironmentStore;
  let nowMs: number;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-env-"));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    nowMs = 1_000;
    store = await createWorkerEnvironmentStore({ database, now: () => nowMs });
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
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

  it("revalidates agent incarnation inside worker admission without joining its writer lock", async () => {
    const options = { path: database.path };
    const config = { agents: { entries: { worker: {} } } };
    const binding = captureAgentLifecycleBinding(config, "worker", options);
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
      recordAgentProvenance("worker", { createdVia: "operator" }, { ...options, nowMs: 42 });
      await expect(create("replaced-agent")).rejects.toThrow("Agent incarnation changed");
    }, options);
    expect(store.get("replaced-agent")).toBeUndefined();
  });

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

  function attachedPatch(sessionId: string, suffix: string) {
    return {
      attachedSessionIds: [sessionId],
      credential: {
        credentialHash: hashWorkerCredential([CREDENTIAL, suffix].join("-")),
        sessionId,
        rpcSetVersion: 1,
        expiresAtMs: nowMs + 10_000,
      },
    };
  }

  it("persists immutable intent before provisioning and survives reopen", async () => {
    const snapshot = { settings: { region: "original" }, lifetime: { idleMinutes: 10 } };
    expect(await createIntent("worker-crash", snapshot)).toMatchObject({
      environmentId: "worker-crash",
      providerId: "fake-provider",
      profileId: "test-profile",
      profileSnapshot: snapshot,
      provisionOperationId: "provision:worker-crash",
      leaseId: null,
      sshEndpoint: null,
      bootstrapReceipt: null,
      teardownTerminalState: null,
      state: "requested",
      attachedSessionIds: [],
      createdAtMs: 1_000,
      updatedAtMs: 1_000,
      stateChangedAtMs: 1_000,
      destroyRequestedAtMs: null,
      lastError: null,
    });

    snapshot.settings.region = "mutated-after-create";
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = await createWorkerEnvironmentStore({ database, now: () => nowMs });

    expect(store.get("worker-crash")?.profileSnapshot).toEqual({
      settings: { region: "original" },
      lifetime: { idleMinutes: 10 },
    });
  });

  it("persists a destroy request without inventing an unleased lifecycle state", async () => {
    await createIntent("worker-cancelled");
    nowMs = 1_050;

    expect(
      await store.requestDestroy({ environmentId: "worker-cancelled", state: "requested" }),
    ).toMatchObject({
      state: "requested",
      leaseId: null,
      destroyRequestedAtMs: 1_050,
      teardownTerminalState: "destroyed",
      updatedAtMs: 1_050,
    });

    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = await createWorkerEnvironmentStore({ database, now: () => nowMs });
    expect(store.get("worker-cancelled")?.destroyRequestedAtMs).toBe(1_050);
  });

  it("persists the complete lifecycle with canonical attachment metadata", async () => {
    await createIntent();
    nowMs = 1_010;
    await store.transition({ environmentId: "worker-1", from: "requested", to: "provisioning" });
    nowMs = 1_020;
    await store.transition({
      environmentId: "worker-1",
      from: "provisioning",
      to: "bootstrapping",
      patch: { leaseId: "lease-1", sshEndpoint: SSH_ENDPOINT, sharedHost: true },
    });
    nowMs = 1_030;
    await store.transition({
      environmentId: "worker-1",
      from: "bootstrapping",
      to: "ready",
      patch: readyPatch(),
    });
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = await createWorkerEnvironmentStore({ database, now: () => nowMs });
    expect(store.get("worker-1")).toMatchObject({
      sshEndpoint: SSH_ENDPOINT,
      sharedHost: true,
      bootstrapReceipt: {
        ...BOOTSTRAP_RECEIPT,
        protocolFeatures: ["model-proxy-v1", "workspace-sync-v1"],
      },
    });
    expect(store.list()[0]?.sshEndpoint).toEqual(SSH_ENDPOINT);
    expect(fallbackPortRows("worker-1")).toEqual([
      { position: 0, port: 22 },
      { position: 1, port: 2200 },
    ]);
    nowMs = 1_040;
    expect(
      await store.transition({
        environmentId: "worker-1",
        from: "ready",
        to: "attached",
        patch: { ...attachedPatch("session-a", "session-a"), attachedSessionIds: [" session-a "] },
      }),
    ).toMatchObject({
      state: "attached",
      attachedSessionIds: ["session-a"],
      leaseId: "lease-1",
      sshEndpoint: SSH_ENDPOINT,
    });
    nowMs = 1_050;
    expect(
      await store.transition({ environmentId: "worker-1", from: "attached", to: "idle" }),
    ).toMatchObject({ state: "idle", attachedSessionIds: [], idleSinceAtMs: 1_050 });
    nowMs = 1_055;
    await store.transition({
      environmentId: "worker-1",
      from: "idle",
      to: "attached",
      patch: attachedPatch("session-c", "session-c"),
    });
    nowMs = 1_060;
    expect(
      await store.transition({ environmentId: "worker-1", from: "attached", to: "draining" }),
    ).toMatchObject({ state: "draining", attachedSessionIds: [] });
    nowMs = 1_070;
    await store.transition({ environmentId: "worker-1", from: "draining", to: "destroying" });

    expect(store.listForReconcile().map((record) => record.state)).toEqual(["destroying"]);
    nowMs = 1_080;
    expect(
      await store.transition({ environmentId: "worker-1", from: "destroying", to: "destroyed" }),
    ).toMatchObject({
      state: "destroyed",
      stateChangedAtMs: 1_080,
      idleSinceAtMs: null,
      attachedSessionIds: [],
      sshEndpoint: SSH_ENDPOINT,
    });
    expect(fallbackPortRows("worker-1")).toEqual([
      { position: 0, port: 22 },
      { position: 1, port: 2200 },
    ]);
    expect(store.listForReconcile()).toEqual([]);
  });

  it.each([
    { name: "none", fallbackPorts: [] },
    { name: "one", fallbackPorts: [2201] },
    { name: "non-numeric order", fallbackPorts: [2201, 22] },
    { name: "ten", fallbackPorts: Array.from({ length: 10 }, (_, index) => 2310 - index) },
  ])("replaces and reopens ordered SSH fallback rows ($name)", async ({ fallbackPorts }) => {
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
  });

  it.each([0, 65_536, 9_007_199_254_740_993n])(
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

  it("enforces canonical companion-table constraints and cascading ownership", async () => {
    await createIntent("worker-constraints");
    expect(
      database.db
        .prepare(
          "SELECT strict FROM pragma_table_list WHERE name = 'worker_environment_ssh_fallback_ports'",
        )
        .get(),
    ).toEqual({ strict: 1 });
    const insert = database.db.prepare(
      `INSERT INTO worker_environment_ssh_fallback_ports (environment_id, position, port)
       VALUES (?, ?, ?)`,
    );
    expect(() => insert.run("worker-constraints", -1, 22)).toThrow();
    expect(() => insert.run("worker-constraints", 10, 22)).toThrow();
    expect(() => insert.run("worker-constraints", 0, 0)).toThrow();
    expect(() => insert.run("worker-constraints", 0, 65_536)).toThrow();
    expect(() => insert.run("missing-worker", 0, 22)).toThrow();

    insert.run("worker-constraints", 0, 22);
    expect(() => insert.run("worker-constraints", 0, 2200)).toThrow();
    expect(() => insert.run("worker-constraints", 1, 22)).toThrow();
    database.db
      .prepare("DELETE FROM worker_environments WHERE environment_id = ?")
      .run("worker-constraints");
    expect(fallbackPortRows("worker-constraints")).toEqual([]);
  });

  it.each<WorkerDesktopEndpoint>([
    DESKTOP,
    {
      protocol: "rfb",
      port: 5900,
      passwordFilePath: "/var/db/crabbox/openclaw-vnc.password",
      username: "ec2-user",
      allowsResize: false,
    },
    {
      protocol: "rfb",
      port: 5900,
      passwordFilePath: "C:\\ProgramData\\crabbox\\vnc.password",
      allowsResize: false,
    },
  ])("round-trips $passwordFilePath and clears it with the provider lease", async (desktop) => {
    await createIntent("worker-desktop");
    await store.transition({
      environmentId: "worker-desktop",
      from: "requested",
      to: "provisioning",
    });
    await store.transition({
      environmentId: "worker-desktop",
      from: "provisioning",
      to: "bootstrapping",
      patch: { leaseId: "lease-desktop", sshEndpoint: SSH_ENDPOINT, desktop },
    });
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = await createWorkerEnvironmentStore({ database, now: () => nowMs });
    expect(store.get("worker-desktop")?.desktop).toEqual(desktop);

    const requested = await store.requestDestroy({
      environmentId: "worker-desktop",
      state: "bootstrapping",
      terminalState: "failed",
    });
    const draining = await store.transition({
      environmentId: requested.environmentId,
      from: requested.state,
      to: "draining",
    });
    const destroying = await store.transition({
      environmentId: draining.environmentId,
      from: draining.state,
      to: "destroying",
    });
    expect(
      await store.transition({
        environmentId: destroying.environmentId,
        from: destroying.state,
        to: "failed",
        patch: { leaseId: null, sshEndpoint: null, lastError: "teardown complete" },
      }),
    ).toMatchObject({ leaseId: null, sshEndpoint: null, desktop: null });
  });

  it("idempotently ensures desktop_json on an existing state database", () => {
    ensureAdditiveStateColumns(database.db, "runtime");
    ensureAdditiveStateColumns(database.db, "runtime");
    const columns = database.db.prepare("PRAGMA table_info(worker_environments)").all() as Array<{
      name: string;
    }>;
    expect(columns.filter((column) => column.name === "desktop_json")).toHaveLength(1);
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

  it("revokes one environment credential without changing lifecycle state", async () => {
    const bootstrapping = await seedBootstrapping("worker-revocation", "lease-revocation");
    await store.transition({
      environmentId: bootstrapping.environmentId,
      from: bootstrapping.state,
      to: "ready",
      patch: readyPatch(),
    });
    expect(store.getCredential(bootstrapping.environmentId)).toBeDefined();

    await store.revokeEnvironmentCredential(bootstrapping.environmentId);

    expect(store.getCredential(bootstrapping.environmentId)).toBeUndefined();
    expect(store.get(bootstrapping.environmentId)?.state).toBe("ready");
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

  it("persists retryable errors without a self-transition", async () => {
    const initialVersion = store.inventoryVersion();
    await createIntent();
    const createdVersion = store.inventoryVersion();
    expect(createdVersion).toBeGreaterThan(initialVersion);
    nowMs = 1_010;
    await store.transition({ environmentId: "worker-1", from: "requested", to: "provisioning" });
    const provisioningVersion = store.inventoryVersion();
    expect(provisioningVersion).toBeGreaterThan(createdVersion);
    const stateChangedAtMs = store.get("worker-1")?.stateChangedAtMs;
    expect(store.inventoryVersion()).toBe(provisioningVersion);

    nowMs = 1_020;
    expect(
      await store.recordError({
        environmentId: "worker-1",
        state: "provisioning",
        error: "provider temporarily unavailable",
      }),
    ).toMatchObject({
      state: "provisioning",
      stateChangedAtMs,
      updatedAtMs: 1_020,
      lastError: "provider temporarily unavailable",
    });
    expect(store.inventoryVersion()).toBeGreaterThan(provisioningVersion);
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
    ["missing", undefined],
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
