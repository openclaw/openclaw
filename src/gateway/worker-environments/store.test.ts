import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  createWorkerEnvironmentStore,
  type WorkerEnvironmentProfileSnapshot,
  type WorkerEnvironmentSshEndpoint,
  type WorkerEnvironmentStore,
} from "./store.js";

const SSH_ENDPOINT: WorkerEnvironmentSshEndpoint = {
  host: "worker.example.test",
  port: 22,
  user: "openclaw",
  keyRef: {
    source: "file",
    provider: "worker-keys",
    id: "/static-development-key",
  },
};

describe("worker environment store", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let store: WorkerEnvironmentStore;
  let nowMs: number;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-env-"));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    nowMs = 1_000;
    store = createWorkerEnvironmentStore({ database, now: () => nowMs });
  });

  afterEach(async () => {
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

  it("persists immutable intent before provisioning and survives reopen", () => {
    const snapshot = { settings: { region: "original" }, lifetime: { idleMinutes: 10 } };
    expect(createIntent("worker-crash", snapshot)).toMatchObject({
      environmentId: "worker-crash",
      providerId: "fake-provider",
      profileId: "test-profile",
      profileSnapshot: snapshot,
      provisionOperationId: "provision:worker-crash",
      leaseId: null,
      sshEndpoint: null,
      state: "requested",
      attachedSessionIds: [],
      createdAtMs: 1_000,
      updatedAtMs: 1_000,
      stateChangedAtMs: 1_000,
      destroyRequestedAtMs: null,
      lastError: null,
    });

    snapshot.settings.region = "mutated-after-create";
    closeOpenClawStateDatabaseForTest();
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerEnvironmentStore({ database, now: () => nowMs });

    expect(store.get("worker-crash")?.profileSnapshot).toEqual({
      settings: { region: "original" },
      lifetime: { idleMinutes: 10 },
    });
  });

  it("persists a destroy request without inventing an unleased lifecycle state", () => {
    createIntent("worker-cancelled");
    nowMs = 1_050;

    expect(
      store.requestDestroy({ environmentId: "worker-cancelled", state: "requested" }),
    ).toMatchObject({
      state: "requested",
      leaseId: null,
      destroyRequestedAtMs: 1_050,
      updatedAtMs: 1_050,
    });

    closeOpenClawStateDatabaseForTest();
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerEnvironmentStore({ database, now: () => nowMs });
    expect(store.get("worker-cancelled")?.destroyRequestedAtMs).toBe(1_050);
  });

  it("persists the complete lifecycle with canonical attachment metadata", () => {
    createIntent();
    nowMs = 1_010;
    store.transition({ environmentId: "worker-1", from: "requested", to: "provisioning" });
    nowMs = 1_020;
    store.transition({
      environmentId: "worker-1",
      from: "provisioning",
      to: "bootstrapping",
      patch: { leaseId: "lease-1", sshEndpoint: SSH_ENDPOINT },
    });
    nowMs = 1_030;
    store.transition({ environmentId: "worker-1", from: "bootstrapping", to: "ready" });
    nowMs = 1_040;
    expect(
      store.transition({
        environmentId: "worker-1",
        from: "ready",
        to: "attached",
        patch: { attachedSessionIds: ["session-b", " session-a ", "session-b"] },
      }),
    ).toMatchObject({
      state: "attached",
      attachedSessionIds: ["session-a", "session-b"],
      leaseId: "lease-1",
      sshEndpoint: SSH_ENDPOINT,
    });
    nowMs = 1_050;
    expect(
      store.transition({ environmentId: "worker-1", from: "attached", to: "idle" }),
    ).toMatchObject({ state: "idle", attachedSessionIds: [], idleSinceAtMs: 1_050 });
    nowMs = 1_055;
    store.transition({
      environmentId: "worker-1",
      from: "idle",
      to: "attached",
      patch: { attachedSessionIds: ["session-c"] },
    });
    nowMs = 1_060;
    expect(
      store.transition({ environmentId: "worker-1", from: "attached", to: "draining" }),
    ).toMatchObject({ state: "draining", attachedSessionIds: [] });
    nowMs = 1_070;
    store.transition({ environmentId: "worker-1", from: "draining", to: "destroying" });

    expect(store.listForReconcile().map((record) => record.state)).toEqual(["destroying"]);
    nowMs = 1_080;
    expect(
      store.transition({ environmentId: "worker-1", from: "destroying", to: "destroyed" }),
    ).toMatchObject({
      state: "destroyed",
      stateChangedAtMs: 1_080,
      idleSinceAtMs: null,
      attachedSessionIds: [],
    });
    expect(store.listForReconcile()).toEqual([]);
  });

  it("rejects illegal, stale, and lease-incomplete transitions", () => {
    createIntent();
    expect(() =>
      store.transition({ environmentId: "worker-1", from: "requested", to: "ready" }),
    ).toThrow("Illegal worker environment transition");

    store.transition({ environmentId: "worker-1", from: "requested", to: "provisioning" });
    expect(() =>
      store.transition({
        environmentId: "worker-1",
        from: "requested",
        to: "provisioning",
      }),
    ).toThrow("state conflict");
    expect(() =>
      store.transition({
        environmentId: "worker-1",
        from: "provisioning",
        to: "bootstrapping",
      }),
    ).toThrow("requires a provider lease");
    expect(() =>
      store.transition({
        environmentId: "worker-1",
        from: "provisioning",
        to: "bootstrapping",
        patch: { leaseId: "lease-1" },
      }),
    ).toThrow("requires an SSH endpoint reference");

    store.transition({
      environmentId: "worker-1",
      from: "provisioning",
      to: "bootstrapping",
      patch: { leaseId: "lease-1", sshEndpoint: SSH_ENDPOINT },
    });
    expect(() =>
      store.transition({
        environmentId: "worker-1",
        from: "bootstrapping",
        to: "ready",
        patch: { leaseId: "different-lease" },
      }),
    ).toThrow("lease id is immutable");
  });

  it("persists retryable errors without a self-transition", () => {
    createIntent();
    nowMs = 1_010;
    store.transition({ environmentId: "worker-1", from: "requested", to: "provisioning" });
    const stateChangedAtMs = store.get("worker-1")?.stateChangedAtMs;

    nowMs = 1_020;
    expect(
      store.recordError({
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
  });

  it("accepts only SecretRef metadata for persisted SSH keys", () => {
    createIntent();
    store.transition({ environmentId: "worker-1", from: "requested", to: "provisioning" });
    const plaintextEndpoint = {
      ...SSH_ENDPOINT,
      keyRef: "plaintext-private-key",
    } as unknown as WorkerEnvironmentSshEndpoint;
    const noncanonicalEndpoint = {
      ...SSH_ENDPOINT,
      keyRef: { source: "file", provider: "worker-keys", id: "private-key" },
    } as WorkerEnvironmentSshEndpoint;

    for (const sshEndpoint of [plaintextEndpoint, noncanonicalEndpoint]) {
      expect(() =>
        store.transition({
          environmentId: "worker-1",
          from: "provisioning",
          to: "bootstrapping",
          patch: { leaseId: "lease-1", sshEndpoint },
        }),
      ).toThrow("SSH key must be a canonical SecretRef");
    }
  });
});
