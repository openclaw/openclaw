import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type {
  WorkerDesktopEndpoint,
  WorkerProfile,
  WorkerSshEndpoint,
} from "../../plugins/types.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { hashWorkerCredential } from "./credential.js";
import { REQUEST, seedActivePlacement } from "./placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
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
  apps: [
    {
      id: "browser",
      executablePath: "/usr/local/bin/openclaw-worker-browser",
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

describe("worker environment runtime refresh", () => {
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

  function seedBootstrapping(environmentId: string, leaseId: string) {
    createIntent(environmentId);
    store.transition({ environmentId, from: "requested", to: "provisioning" });
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

  const replacement = {
    ...BOOTSTRAP_RECEIPT,
    bundleHash: "c".repeat(64),
    openclawVersion: "2026.7.2",
    protocolFeatures: BOOTSTRAP_RECEIPT.protocolFeatures.toSorted(),
  };

  function seedRefresh(state: "ready" | "idle" | "attached", transport: "node" | "ssh" = "node") {
    const environmentId = "worker-refresh";
    if (transport === "ssh") {
      seedBootstrapping(environmentId, "lease-refresh");
      store.transition({
        environmentId,
        from: "bootstrapping",
        to: "ready",
        patch: readyPatch(),
      });
    } else {
      createIntent(environmentId);
      store.transition({ environmentId, from: "requested", to: "provisioning" });
      store.transition({
        environmentId,
        from: "provisioning",
        to: "ready",
        patch: {
          ...readyPatch(),
          leaseId: "lease-refresh",
          nodeDeviceId: "node-refresh",
          desktop: DESKTOP,
        },
      });
    }
    if (state !== "ready") {
      store.transition({
        environmentId,
        from: "ready",
        to: state,
        ...(state === "attached" ? { patch: attachedPatch(REQUEST.sessionId, "refresh") } : {}),
      });
    }
    let environment = store.get(environmentId)!;
    const placements = createWorkerSessionPlacementStore({ database, now: () => nowMs });
    const placement =
      state === "attached"
        ? seedActivePlacement(placements, { environmentId, ownerEpoch: environment.ownerEpoch })
        : undefined;
    environment = store.get(environmentId)!;
    store.revokeEnvironmentCredential(environmentId);
    const input = {
      environmentId,
      expectedOwnerEpoch: environment.ownerEpoch,
      expectedNodeDeviceId: environment.nodeDeviceId,
      expectedBootstrapReceipt: environment.bootstrapReceipt!,
      bootstrapReceipt: replacement,
      assertCurrent: () => {},
      ...(state === "attached"
        ? { expectedState: state, expectedPlacementGeneration: placement!.generation }
        : { expectedState: state }),
    };
    return { environment, placements, placement, input };
  }

  it.each([
    ["ready", "node"],
    ["idle", "node"],
    ["attached", "node"],
    ["attached", "ssh"],
  ] as const)(
    "refreshes %s %s runtime without replacing its machine or workspace",
    (state, transport) => {
      const { environment, placements, placement, input } = seedRefresh(state, transport);
      nowMs += 1_000;
      expect(store.refreshBootstrapReceipt(input)).toEqual({
        ...environment,
        bootstrapReceipt: replacement,
        updatedAtMs: nowMs,
      });
      expect(store.getCredential(environment.environmentId)).toBeUndefined();
      if (placement) {
        expect(placements.get(placement.sessionId)).toEqual({
          ...placement,
          workerBundleHash: replacement.bundleHash,
          updatedAtMs: nowMs,
        });
      }
      closeOpenClawStateDatabaseForTest();
      database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
      store = createWorkerEnvironmentStore({ database, now: () => nowMs });
      expect(store.get(environment.environmentId)?.bootstrapReceipt).toEqual(replacement);
      if (placement) {
        expect(
          createWorkerSessionPlacementStore({ database }).get(placement.sessionId),
        ).toMatchObject({
          workerBundleHash: replacement.bundleHash,
          activeOwnerEpoch: placement.activeOwnerEpoch,
          remoteWorkspaceDir: placement.remoteWorkspaceDir,
        });
      }
    },
  );

  it("rejects stale refresh identity and renewed credentials without changing either receipt", () => {
    const { environment, placements, placement, input } = seedRefresh("attached");
    const staleInputs = [
      { ...input, expectedOwnerEpoch: input.expectedOwnerEpoch + 1 },
      { ...input, expectedNodeDeviceId: "node-replaced" },
      {
        ...input,
        expectedBootstrapReceipt: { ...BOOTSTRAP_RECEIPT, openclawVersion: "2026.6.1" },
      },
      { ...input, expectedBootstrapReceipt: { ...BOOTSTRAP_RECEIPT, protocolFeatures: [] } },
      {
        ...input,
        expectedState: "attached" as const,
        expectedPlacementGeneration: placement!.generation + 1,
      },
      {
        ...input,
        assertCurrent: () => {
          throw new Error("Worker turn acquired live authority");
        },
      },
    ];
    for (const stale of staleInputs) {
      expect(() => store.refreshBootstrapReceipt(stale)).toThrow();
      expect(store.get(environment.environmentId)).toEqual(environment);
      expect(placements.get(placement!.sessionId)).toEqual(placement);
    }
    store.renewCredential({
      ...attachedPatch(REQUEST.sessionId, "renewed").credential,
      environmentId: environment.environmentId,
      expectedOwnerEpoch: environment.ownerEpoch,
    });
    expect(() => store.refreshBootstrapReceipt(input)).toThrow("previous credential to be revoked");
    expect(store.get(environment.environmentId)).toEqual(environment);
    expect(placements.get(placement!.sessionId)).toEqual(placement);
  });

  it("rolls back the placement receipt when the environment write fails", () => {
    const { environment, placements, placement, input } = seedRefresh("attached");
    database.db.exec(`CREATE TEMP TRIGGER reject_runtime_receipt
      BEFORE UPDATE OF bootstrap_bundle_hash ON worker_environments
      BEGIN SELECT RAISE(ABORT, 'runtime receipt write failed'); END`);
    expect(() => store.refreshBootstrapReceipt(input)).toThrow("runtime receipt write failed");
    expect(store.get(environment.environmentId)).toEqual(environment);
    expect(placements.get(placement!.sessionId)).toEqual(placement);
    database.db.exec("DROP TRIGGER reject_runtime_receipt");
    expect(store.refreshBootstrapReceipt(input).bootstrapReceipt).toEqual(replacement);
  });

  it.each(["draining", "moving", "destroying"] as const)(
    "does not refresh an owner that is %s",
    (operation) => {
      const { environment, placements, placement, input } = seedRefresh("attached");
      if (operation === "destroying") {
        store.requestDestroy({ environmentId: environment.environmentId, state: "attached" });
      } else if (operation === "moving") {
        placements.beginPlacementMove({
          sessionId: placement!.sessionId,
          source: {
            generation: placement!.generation,
            environmentId: environment.environmentId,
            ownerEpoch: environment.ownerEpoch,
          },
          target: { kind: "gateway" },
        });
      } else {
        placements.startDrain({
          sessionId: placement!.sessionId,
          environmentId: environment.environmentId,
          ownerEpoch: environment.ownerEpoch,
          expectedGeneration: placement!.generation,
        });
      }
      const beforeEnvironment = store.get(environment.environmentId);
      const beforePlacement = placements.get(placement!.sessionId);
      expect(() => store.refreshBootstrapReceipt(input)).toThrow();
      expect(store.get(environment.environmentId)).toEqual(beforeEnvironment);
      expect(placements.get(placement!.sessionId)).toEqual(beforePlacement);
    },
  );

  it("preserves a recovery-only claim and its pending workspace result", () => {
    const { environment, placements, placement, input } = seedRefresh("attached");
    const claim = placements.claimTurn({
      ...REQUEST,
      claimId: "interrupted-claim",
      runId: "interrupted-run",
      owner: {
        kind: "worker",
        environmentId: environment.environmentId,
        ownerEpoch: environment.ownerEpoch,
      },
    });
    placements.markWorkspaceResultPending(claim);
    const pending = placements.listPendingWorkspaceResults();
    const beforePlacement = placements.get(placement!.sessionId);
    const binding = {
      sessionId: REQUEST.sessionId,
      environmentId: environment.environmentId,
      ownerEpoch: environment.ownerEpoch,
    };
    const liveGate = createWorkerSessionPlacementGate(placements);
    expect(() =>
      store.refreshBootstrapReceipt({
        ...input,
        assertCurrent: () => {
          liveGate.assertWorkerRuntimeRefresh(binding);
        },
      }),
    ).toThrow("current turn");
    const recoveryGate = createWorkerSessionPlacementGate(placements, {
      rejectExistingWorkerClaims: true,
    });
    store.refreshBootstrapReceipt({
      ...input,
      assertCurrent: () => {
        recoveryGate.assertWorkerRuntimeRefresh(binding);
      },
    });
    expect(placements.get(placement!.sessionId)).toEqual({
      ...beforePlacement,
      workerBundleHash: replacement.bundleHash,
    });
    expect(placements.listPendingWorkspaceResults()).toEqual(pending);
    expect(placements.validateWorkspaceResultClaim(claim)).toBe(true);
    expect(recoveryGate.validateWorkerTurn(claim)).toBe(false);
    expect(store.getCredential(environment.environmentId)).toBeUndefined();
  });
});
