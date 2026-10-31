import { expect, it } from "vitest";
import { summarizeWorkerEnvironment } from "./environment-summary.js";
import type { WorkerEnvironmentServiceRecord } from "./service-contract.js";

it.each([
  ["ready", "lease-1", 2, undefined, "stopping", "ready"],
  ["attached", "lease-1", 2, undefined, "stopping", "attached"],
  ["idle", "lease-1", 2, "stop failed", "error", "idle"],
  ["ready", "lease-1", null, undefined, "available", "ready"],
  ["destroyed", "lease-1", 2, undefined, "unavailable", "destroyed"],
  ["failed", null, 2, "provision failed", "error", "failed"],
] as const)(
  "projects %s with lease=%s, destroyRequestedAtMs=%s and error=%s",
  (state, leaseId, destroyRequestedAtMs, error, status, workerState) => {
    const record: WorkerEnvironmentServiceRecord = {
      environmentId: "worker-1",
      providerId: "crabbox",
      profileId: "development",
      state,
      leaseId,
      resourceReceipt: null,
      retention: null,
      destroyRequestedAtMs,
      error,
      ownerEpoch: 1,
      createdAtMs: 1,
      idleSinceAtMs: null,
      sharedHost: false,
      attachedSessionIds: [],
      desktopAvailable: false,
      desktopApps: [],
      tunnelStatus: "stopped",
    };

    expect(summarizeWorkerEnvironment(record, 3)).toMatchObject({
      status,
      worker: { state: workerState, ...(error ? { error } : {}) },
    });
  },
);
