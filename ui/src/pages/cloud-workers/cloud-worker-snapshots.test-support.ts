import type { SnapshotsResult } from "./cloud-worker-snapshot-rows.ts";

export function snapshotListFixture(): SnapshotsResult {
  const images: SnapshotsResult["images"] = [
    {
      profileKey: "profile-key-project",
      profileId: "linux-build",
      backend: "aws",
      machineClass: "standard",
      os: "linux",
      projectKey: "project-key-app",
      projectLabel: "github.com/acme/app",
      checkpointId: "image-app",
      state: "available",
      createdAtMs: Date.now() - 3_600_000,
      lastDemandAtMs: Date.now() - 60_000,
      baseCommit: "0123456789abcdef",
      runtimeIdentity: {
        nodeBootstrapSha256: "abcdef0123456789".repeat(4),
      },
      allocationCount: 21,
      held: true,
      retirement: { checkpointId: "image-app-predecessor" },
    },
    {
      profileKey: "profile-key-retiring",
      profileId: "retiring-build",
      projectKey: "project-key-retiring",
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
      capture: {
        selector: "capture-uncertain",
        phase: "uncertain",
        stale: false,
      },
    },
    {
      profileKey: "profile-key-machine",
      profileId: "linux-build",
      backend: "aws",
      machineClass: "burst",
      state: "no-image",
      allocationCount: 1,
      held: false,
      capture: {
        selector: "capture-building",
        phase: "creating",
        stale: true,
      },
    },
  ];
  return {
    images,
    profiles: [
      {
        id: "linux-build",
        backend: "aws",
        machineClass: "configured-class",
        os: "linux",
        warmImages: "on",
        reason: "Warm images are enabled for this Linux class.",
      },
      {
        id: "cold-build",
        backend: "aws",
        machineClass: "standard",
        os: "linux",
        warmImages: "off",
        reason: "Warm images are explicitly disabled.",
      },
      {
        id: "classless-build",
        backend: "aws",
        os: "linux",
        warmImages: "off",
        reason: "A machine class is required.",
      },
    ],
    legacyLeases: [
      {
        leaseId: "legacy-worker",
        selector: "legacy-lease-selector",
        recoveryHint:
          "Stop the owning Gateway and capture processes, confirm the worker is stopped, then run openclaw doctor --fix.",
      },
    ],
  };
}
