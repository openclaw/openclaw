type SnapshotFixtureImage = {
  profileKey: string;
  profileId?: string;
  backend?: string;
  machineClass?: string;
  os?: string;
  projectKey?: string;
  projectLabel?: string;
  checkpointId?: string;
  state: "pending" | "available" | "no-image";
  createdAtMs?: number;
  lastDemandAtMs?: number | null;
  baseCommit?: string;
  runtimeIdentity?: {
    nodeBootstrapSha256: string;
    executionMode: "worker-turn" | "remote-exec";
    workerBundleSha256?: string;
  };
  pinned?: { atMs: number };
  previous?: {
    checkpointId: string;
    createdAtMs: number;
    baseCommit?: string;
    runtimeIdentity?: SnapshotFixtureImage["runtimeIdentity"];
    pinned?: { atMs: number };
  };
  allocations: Record<string, never>;
  allocationCount: number;
  held: boolean;
  retirement?: { checkpointId: string };
  capture?: {
    selector: string;
    phase: "scrubbing" | "creating" | "uncertain";
    stale: boolean;
    startedAtMs: number;
  };
};

export function snapshotListFixture() {
  const images: SnapshotFixtureImage[] = [
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
        executionMode: "worker-turn",
      },
      allocations: {},
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
      allocations: {},
      allocationCount: 0,
      held: false,
      retirement: { checkpointId: "image-retiring" },
    },
    {
      profileKey: "profile-key-legacy",
      projectKey: "project-key-legacy",
      state: "no-image",
      allocations: {},
      allocationCount: 0,
      held: false,
      capture: {
        selector: "capture-uncertain",
        phase: "uncertain",
        stale: false,
        startedAtMs: Date.now(),
      },
    },
    {
      profileKey: "profile-key-machine",
      profileId: "linux-build",
      backend: "aws",
      machineClass: "burst",
      state: "no-image",
      allocations: {},
      allocationCount: 1,
      held: false,
      capture: {
        selector: "capture-building",
        phase: "creating",
        stale: true,
        startedAtMs: Date.now() - 1_800_000,
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
