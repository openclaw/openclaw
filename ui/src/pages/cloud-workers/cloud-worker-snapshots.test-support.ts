import type { SnapshotsResult } from "./cloud-worker-environment-model.ts";

export function buildEnvironmentFixture(state = "provisioning", error?: string) {
  return {
    id: "build-app",
    type: "worker",
    status:
      state === "ready"
        ? "available"
        : state === "failed" || state === "orphaned"
          ? "error"
          : "starting",
    preparation: {
      purpose: "build",
      key: "build-key",
      details: {
        demandAtMs: 1,
        expiresAtMs: Date.now() + 3_600_000,
        consumedAtMs: null,
        project: { label: "github.com/acme/app", baseCommit: "0123456789abcdef" },
      },
    },
    worker: {
      profileId: "linux-build",
      providerId: "crabbox",
      state,
      ageMs: 60_000,
      attachedSessionIds: [],
      tunnelStatus: "stopped",
      ...(error ? { error } : {}),
    },
  };
}

export function snapshotListFixture(): SnapshotsResult {
  return {
    images: [
      {
        profileKey: "profile-key-project",
        profileId: "linux-build",
        backend: "aws",
        machineClass: "standard",
        os: "linux",
        projectLabel: "github.com/acme/app",
        checkpointId: "image-app",
        state: "available",
        createdAtMs: Date.now() - 3_600_000,
        lastDemandAtMs: Date.now() - 60_000,
        baseCommit: "0123456789abcdef",
        allocationCount: 21,
        held: true,
        retirement: { checkpointId: "image-app-predecessor" },
      },
      {
        profileKey: "profile-key-retiring",
        profileId: "retiring-build",
        projectLabel: "github.com/acme/retiring",
        checkpointId: "image-retiring",
        state: "available",
        allocationCount: 0,
        held: false,
        retirement: { checkpointId: "image-retiring" },
      },
      {
        profileKey: "profile-key-legacy",
        projectKey: "project-key-legacy",
        state: "no-image",
        allocationCount: 0,
        held: false,
        capture: { selector: "capture-uncertain", phase: "uncertain", stale: false },
      },
      {
        profileKey: "profile-key-machine",
        profileId: "linux-build",
        state: "no-image",
        allocationCount: 1,
        held: false,
        capture: { selector: "capture-building", phase: "creating", stale: true },
      },
    ],
    profiles: [
      {
        id: "linux-build",
        backend: "aws",
        machineClass: "configured-class",
        os: "linux",
        warmImages: "on",
        reason: "Warm images are enabled for this Linux class.",
      },
    ],
    legacyLeases: [
      {
        leaseId: "legacy-worker",
        selector: "legacy-lease-selector",
        recoveryHint: "Stop the worker, then run openclaw doctor --fix.",
      },
    ],
  };
}
