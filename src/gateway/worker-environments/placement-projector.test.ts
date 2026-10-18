import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  SessionPlacementMoveSchema,
  SessionPlacementSchema,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  createWorkerPlacementRunnerAvailabilityReader,
  createWorkerPlacementRuntimeInstallReader,
  projectWorkerPlacementMove,
  projectWorkerSessionPlacement,
  readWorkerPlacementIdentity,
} from "./placement-projector.js";
import type { WorkerSessionPlacementRecord } from "./placement-store.js";

const BUNDLE_HASH = "a".repeat(64);

const RECORD_BASE = {
  sessionId: "session-1",
  agentId: "main",
  sessionKey: "agent:main:session-1",
  executionMode: "worker-turn" as const,
  generation: 4,
  workspaceBaseManifestRef: null,
  remoteWorkspaceDir: null,
  workerBundleHash: null,
  lastTranscriptAckCursor: null,
  lastLiveEventAckCursor: null,
  recoveryError: null,
  terminalReason: null,
  terminalAtMs: null,
  turnClaim: null,
  createdAtMs: 100,
  updatedAtMs: 200,
  stateChangedAtMs: 150,
};

function activePlacement(environmentId = "environment-1") {
  return {
    ...RECORD_BASE,
    state: "active",
    environmentId,
    activeOwnerEpoch: 7,
    workspaceBaseManifestRef: "manifest-1",
    remoteWorkspaceDir: "/workspace",
    workerBundleHash: BUNDLE_HASH,
  } satisfies WorkerSessionPlacementRecord;
}

function provisioningPlacement() {
  return {
    ...RECORD_BASE,
    state: "provisioning" as const,
    environmentId: "environment-1",
    activeOwnerEpoch: null,
  };
}

type Environment = NonNullable<
  ReturnType<
    Parameters<typeof createWorkerPlacementRunnerAvailabilityReader>[0]["environments"]["get"]
  >
>;
function environmentFixture(overrides: Partial<Environment> = {}): Environment {
  return {
    environmentId: "environment-1",
    providerId: "crabbox",
    profileId: "development",
    ownerEpoch: 7,
    state: "attached",
    leaseId: "lease-cloud",
    nodeDeviceId: null,
    sharedHost: false,
    createdAtMs: 1,
    idleSinceAtMs: null,
    destroyRequestedAtMs: null,
    attachedSessionIds: ["session-1"],
    desktopAvailable: false,
    desktopApps: [],
    tunnelStatus: "stopped",
    ...overrides,
  };
}

const PROJECTED_TIMING = {
  generation: 4,
  createdAtMs: 100,
  updatedAtMs: 200,
  stateChangedAtMs: 150,
};

describe("worker placement projection", () => {
  it("limits inference metadata to the exact active worker-turn binding", () => {
    const placement = activePlacement("environment-device");
    const environment = {
      environmentId: placement.environmentId,
      providerId: "device",
      profileId: "named-device",
      ownerEpoch: 7,
      state: "attached" as const,
      leaseId: "lease-device",
      nodeDeviceId: "paired-node",
      attachedSessionIds: [placement.sessionId],
      profileSnapshot: { settings: { device: "paired-node", inference: "worker" } },
      inference: "worker" as const,
    };
    const project = (record: WorkerSessionPlacementRecord, prepared = environment) =>
      projectWorkerSessionPlacement(
        record,
        undefined,
        undefined,
        readWorkerPlacementIdentity(record, undefined, prepared),
      );
    const active = project(placement);
    expect(active).toHaveProperty("inference", "worker");
    expect(Value.Check(SessionPlacementSchema, active)).toBe(true);
    expect(active).not.toHaveProperty("profileSnapshot");
    for (const changed of [
      { ...environment, environmentId: "replacement" },
      { ...environment, ownerEpoch: 8 },
      { ...environment, attachedSessionIds: [] },
      { ...environment, attachedSessionIds: ["other-session"] },
      { ...environment, attachedSessionIds: [placement.sessionId, "other-session"] },
      { ...environment, nodeDeviceId: "" },
    ]) {
      expect(project(placement, changed)).not.toHaveProperty("inference");
    }
    for (const state of ["idle", "draining", "destroyed", "failed", "orphaned"] as const) {
      const identity = readWorkerPlacementIdentity(placement, undefined, { ...environment, state });
      expect(
        projectWorkerSessionPlacement(placement, undefined, undefined, identity),
      ).not.toHaveProperty("inference");
    }
    expect(project({ ...placement, executionMode: "remote-exec" })).not.toHaveProperty("inference");
    for (const state of ["draining", "reconciling", "reclaimed"] as const) {
      const projected = project({ ...placement, state });
      expect(projected).not.toHaveProperty("inference");
      expect(Value.Check(SessionPlacementSchema, projected)).toBe(true);
    }
    expect(project({ ...placement, state: "failed", recoveryError: "stopped" })).not.toHaveProperty(
      "inference",
    );
    expect(
      project({ ...RECORD_BASE, state: "local", environmentId: null, activeOwnerEpoch: null }),
    ).not.toHaveProperty("inference");
  });

  it.each(["local", "requested", "provisioning", "failed", "reclaimed"] as const)(
    "retains machine identity only for worker placement states (%s)",
    (state) => {
      const machine = { class: "medium", os: "linux", osLabel: "Linux", cpu: 4, memoryGb: 16 };
      const identity = { providerId: "crabbox", profileId: "aws", machine };
      const worker = {
        ...RECORD_BASE,
        environmentId: "environment-1",
        activeOwnerEpoch: 7,
        workspaceBaseManifestRef: "manifest-1",
        remoteWorkspaceDir: "/workspace",
        workerBundleHash: BUNDLE_HASH,
      };
      const record: WorkerSessionPlacementRecord =
        state === "local" || state === "requested"
          ? { ...RECORD_BASE, state, environmentId: null, activeOwnerEpoch: null }
          : state === "provisioning"
            ? { ...RECORD_BASE, state, environmentId: "environment-1", activeOwnerEpoch: null }
            : state === "failed"
              ? { ...worker, state, recoveryError: "worker unavailable" }
              : { ...worker, state };
      const projected = projectWorkerSessionPlacement(record, undefined, undefined, identity);
      if (state === "local" || state === "requested") {
        expect(projected).not.toHaveProperty("machine");
      } else {
        expect(projected).toMatchObject({ machine });
      }
      expect(Value.Check(SessionPlacementSchema, projected)).toBe(true);
    },
  );

  it("omits an empty machine result from correlated placement identity", () => {
    const record = provisioningPlacement();
    const identity = readWorkerPlacementIdentity(record, {
      get: () =>
        environmentFixture({
          profileId: "aws",
          ownerEpoch: 1,
          state: "requested",
          leaseId: null,
          sharedHost: null,
          attachedSessionIds: [],
        }),
      readMachineShape: () => ({}),
    });
    expect(identity).toEqual({ providerId: "crabbox", profileId: "aws" });
  });

  it("adds an exact active disk-space sample only when supplied", () => {
    const active = activePlacement();
    const diskSpace = {
      status: "critical" as const,
      availableBytes: 50,
      totalBytes: 1_000,
      observedAtMs: 250,
    };

    expect(projectWorkerSessionPlacement(active, diskSpace)).toMatchObject({ diskSpace });
    expect(projectWorkerSessionPlacement(active)).not.toHaveProperty("diskSpace");
  });

  it("projects provisioning transfers before node assignment and active transfers by stale node build", () => {
    const record = provisioningPlacement();
    const observation = {
      nodeId: "device-1",
      environmentIds: [record.environmentId],
      bundleHash: BUNDLE_HASH,
      phase: "transferring" as const,
      transferredBytes: 0,
      totalBytes: 1_000,
      startedAtMs: 250,
      updatedAtMs: 250,
    };
    const reader = createWorkerPlacementRuntimeInstallReader({
      environments: { get: () => undefined },
      installer: {
        readInstall: (nodeId) => (nodeId === observation.nodeId ? observation : undefined),
        readInstallForEnvironment: (id) => (id === record.environmentId ? observation : undefined),
        version: () => 1,
      },
    });
    const active = { ...activePlacement(), workerBundleHash: "c".repeat(64) };
    const environment = { nodeDeviceId: "device-1" };
    expect(reader.read(record, environment)).toBeUndefined();
    expect(reader.read(active, environment)).toBeUndefined();
    observation.transferredBytes = 100;
    expect(reader.read(active, environment)).toMatchObject({ transferredBytes: 100 });
    const projected = projectWorkerSessionPlacement(
      record,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      false,
      { workerRuntimeInstall: reader.read(record, { nodeDeviceId: null }) },
    );
    expect(projected).toHaveProperty("workerRuntimeInstall", {
      phase: "transferring",
      transferredBytes: 100,
      totalBytes: 1_000,
      startedAtMs: 250,
      updatedAtMs: 250,
    });
    expect(Value.Check(SessionPlacementSchema, projected)).toBe(true);
    expect(reader.read(record, null)).toMatchObject({ transferredBytes: 100 });
    expect(reader.read({ ...record, environmentId: "unrelated" }, environment)).toBeUndefined();
    expect(reader.read(active, null)).toBeUndefined();
    expect(reader.read(active, { nodeDeviceId: "other-device" })).toBeUndefined();
    expect(reader.read(activePlacement(), environment)).toBeUndefined();
    expect(reader.read({ ...activePlacement(), state: "draining" })).toBeUndefined();
  });

  it.each(["active", "draining"] as const)(
    "projects active post-turn workspace reconciliation for %s placements",
    (state) => {
      const placement = {
        ...activePlacement(),
        state,
      } satisfies WorkerSessionPlacementRecord;

      expect(projectWorkerSessionPlacement(placement)).not.toHaveProperty(
        "workspaceResultReconciling",
      );
      const projected = projectWorkerSessionPlacement(
        placement,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      );
      expect(projected).toMatchObject({ workspaceResultReconciling: true });
      expect(Value.Check(SessionPlacementSchema, projected)).toBe(true);
    },
  );

  it("does not project result reconciliation for the move-only reconciling state", () => {
    const placement = {
      ...activePlacement(),
      state: "reconciling",
    } satisfies WorkerSessionPlacementRecord;

    expect(
      projectWorkerSessionPlacement(placement, undefined, undefined, undefined, undefined, true),
    ).not.toHaveProperty("workspaceResultReconciling");
  });

  it("projects device availability from the exact active environment and current runner proof", () => {
    const active = activePlacement("environment-device");
    let connected = false;
    const reader = createWorkerPlacementRunnerAvailabilityReader({
      environments: {
        get: () =>
          environmentFixture({
            environmentId: active.environmentId,
            providerId: "device",
            profileId: "device-profile",
            leaseId: "lease-device",
            nodeDeviceId: "device-1",
            sharedHost: true,
          }),
      },
      hasCurrentDeviceRunner: (deviceId) => deviceId === "device-1" && connected,
    });

    expect(projectWorkerSessionPlacement(active, undefined, reader.read(active))).toMatchObject({
      runner: { kind: "device", deviceId: "device-1", status: "offline" },
    });
    expect(reader.version()).toBe(0);
    connected = true;
    reader.markChanged();
    reader.markChanged();
    reader.markChanged();
    expect(projectWorkerSessionPlacement(active, undefined, reader.read(active))).toMatchObject({
      runner: { kind: "device", deviceId: "device-1", status: "available" },
    });
    expect(reader.version()).toBe(3);
  });

  it("omits runner availability for non-device and inexact environment owners", () => {
    const active = activePlacement("environment-cloud");
    const environment = environmentFixture({ environmentId: active.environmentId });
    const reader = createWorkerPlacementRunnerAvailabilityReader({
      environments: { get: () => environment },
      hasCurrentDeviceRunner: () => true,
    });
    expect(reader.read(active)).toBeUndefined();
    environment.providerId = "device";
    environment.nodeDeviceId = "device-1";
    environment.ownerEpoch += 1;
    expect(reader.read(active)).toBeUndefined();
  });

  it.each([false, true])(
    "projects failed Move retry facts without operation authority (abandon=%s)",
    (abandonSource) => {
      const intent = {
        operationId: "move:v1:opaque",
        sessionId: "session-1",
        source: { generation: 4, environmentId: "environment-1", ownerEpoch: 7 },
        target: { kind: "gateway" as const },
        abandonSource,
        lastError: "device worker is offline",
        createdAtMs: 100,
        updatedAtMs: 200,
      };
      const projected = projectWorkerPlacementMove(intent);

      expect(projected).toEqual({
        target: { kind: "gateway" },
        error: "device worker is offline",
        updatedAtMs: 200,
        retry: {
          expected: { generation: 4, environmentId: "environment-1", ownerEpoch: 7 },
          target: { kind: "gateway" },
          ...(abandonSource ? { abandonSource: true } : {}),
        },
      });
      expect(Value.Check(SessionPlacementMoveSchema, projected)).toBe(true);
      expect(projected).not.toHaveProperty("operationId");
      expect(projected.retry).not.toHaveProperty("operationId");
      expect(projectWorkerPlacementMove({ ...intent, lastError: null })).not.toHaveProperty(
        "retry",
      );
    },
  );

  it("emits only fields valid for each placement discriminator", () => {
    const records = [
      {
        ...RECORD_BASE,
        state: "local",
        environmentId: null,
        activeOwnerEpoch: null,
      },
      provisioningPlacement(),
      {
        ...activePlacement(),
        state: "reclaimed",
        terminalAtMs: 250,
        workspaceResultConflict: {
          paths: ["src/local.ts"],
          stagedResultRef: "refs/openclaw/worker-results/claim-1",
        },
      },
      {
        ...RECORD_BASE,
        state: "failed",
        environmentId: "environment-1",
        activeOwnerEpoch: 7,
        recoveryError: "worker unavailable",
        terminalReason: "worker unavailable",
        terminalAtMs: 260,
      },
    ] satisfies WorkerSessionPlacementRecord[];

    const projected = records.map((record) => projectWorkerSessionPlacement(record));

    expect(projected).toEqual([
      {
        state: "local",
        ...PROJECTED_TIMING,
      },
      {
        state: "provisioning",
        ...PROJECTED_TIMING,
        environmentId: "environment-1",
      },
      {
        state: "reclaimed",
        ...PROJECTED_TIMING,
        environmentId: "environment-1",
        activeOwnerEpoch: 7,
        workspaceBaseManifestRef: "manifest-1",
        remoteWorkspaceDir: "/workspace",
        workerBundleHash: BUNDLE_HASH,
        workspaceResultConflict: {
          paths: ["src/local.ts"],
          stagedResultRef: "refs/openclaw/worker-results/claim-1",
        },
        terminalAtMs: 250,
      },
      {
        state: "failed",
        ...PROJECTED_TIMING,
        environmentId: "environment-1",
        activeOwnerEpoch: 7,
        recoveryError: "worker unavailable",
        terminalReason: "worker unavailable",
        terminalAtMs: 260,
      },
    ]);
    for (const placement of projected) {
      expect(Value.Check(SessionPlacementSchema, placement)).toBe(true);
      expect(placement).not.toHaveProperty("sessionId");
      expect(placement).not.toHaveProperty("sessionKey");
      expect(placement).not.toHaveProperty("turnClaim");
    }
  });
});
