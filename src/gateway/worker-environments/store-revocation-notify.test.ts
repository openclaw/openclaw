import { beforeEach, describe, expect, it } from "vitest";
import type { WorkerSshEndpoint } from "../../plugins/types.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { hashWorkerCredential } from "./credential.js";
import { createWorkerEnvironmentStore, type WorkerEnvironmentStore } from "./store.js";

const SSH_ENDPOINT: WorkerSshEndpoint = {
  host: "worker.example.test",
  port: 2222,
  fallbackPorts: [22],
  user: "openclaw",
  hostKey: ["ssh-ed25519", "AAAA"].join(" "),
  keyRef: { source: "file", provider: "worker-keys", id: "/static-development-key" },
};
const CREDENTIAL = ["worker", "credential", "fixture"].join("-");

describe("worker environment store credential-revocation listeners", () => {
  const tempDirs = useStateDatabaseTempDirs();
  let root: string;
  let store: WorkerEnvironmentStore;
  let nowMs: number;

  beforeEach(async () => {
    root = tempDirs.make("openclaw-worker-env-");
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    nowMs = 1_000;
    store = await createWorkerEnvironmentStore({ database, now: () => nowMs });
  });

  async function seedReady(environmentId: string, leaseId: string, credentialHash: string) {
    await store.createIntent({
      environmentId,
      providerId: "fake-provider",
      profileId: "test-profile",
      profileSnapshot: { settings: { region: "test" }, lifetime: { idleMinutes: 10 } },
      provisionOperationId: `provision:${environmentId}`,
    });
    await store.transition({ environmentId, from: "requested", to: "provisioning" });
    const bootstrapping = await store.transition({
      environmentId,
      from: "provisioning",
      to: "bootstrapping",
      patch: { leaseId, sshEndpoint: SSH_ENDPOINT },
    });
    return store.transition({
      environmentId,
      from: bootstrapping.state,
      to: "ready",
      patch: {
        bootstrapReceipt: {
          bundleHash: "a".repeat(64),
          openclawVersion: "2026.7.1",
          protocolFeatures: ["workspace-sync-v1", "model-proxy-v1"],
        },
        credential: {
          credentialHash,
          sessionId: null,
          rpcSetVersion: 1,
          expiresAtMs: nowMs + 10_000,
        },
      },
    });
  }

  it("notifies credential-revocation listeners only when transfers must fence", async () => {
    const rotating = await seedReady(
      "worker-revoke-rotate",
      "lease-revoke-rotate",
      hashWorkerCredential(CREDENTIAL),
    );
    const permanent = await seedReady(
      "worker-revoke-permanent",
      "lease-revoke-permanent",
      hashWorkerCredential([CREDENTIAL, "revoke-permanent"].join("-")),
    );
    const notified: string[] = [];
    store.onCredentialRevoked((environmentId) => {
      notified.push(environmentId);
    });
    await store.revokeEnvironmentCredential(rotating.environmentId);
    expect(notified).toEqual([]);
    await store.revokeEnvironmentCredential(permanent.environmentId, {
      fenceWorkspaceTransfers: true,
    });
    expect(notified).toEqual([permanent.environmentId]);
  });
});
