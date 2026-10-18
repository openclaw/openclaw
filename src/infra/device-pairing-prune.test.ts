// Covers silent-pairing approval provenance and superseded-record pruning.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { approveBootstrapDevicePairing, approveDevicePairing } from "./device-pairing-approval.js";
import {
  getPairedDevice,
  hasPairedCardRenderer,
  listDevicePairing,
  pruneSupersededSilentPairedDevices,
  requestDevicePairing,
  withPairedDeviceRecords,
} from "./device-pairing.js";

const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-device-pairing-prune-" });
type PairedDeviceApprovalKind = NonNullable<
  Parameters<typeof approveDevicePairing>[1]["approvedVia"]
>;

const suiteStateDirs: string[] = [];

let baseDir: string;
beforeEach(async () => {
  baseDir = await suiteRootTracker.make("case");
  suiteStateDirs.push(baseDir);
});

async function cleanupSuite(): Promise<void> {
  for (const stateDir of suiteStateDirs) {
    await closeOpenClawStateDatabaseByPathAsync(
      resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
    );
  }
  suiteStateDirs.length = 0;
  await suiteRootTracker.cleanup();
}

// Rewrites a paired record without approvedVia to simulate approvals that
// predate provenance tracking.
async function stripApprovalProvenance(deviceId: string): Promise<void> {
  await withPairedDeviceRecords(baseDir, (pairedByDeviceId) => {
    const device = pairedByDeviceId[deviceId];
    if (!device) {
      throw new Error(`expected paired device ${deviceId}`);
    }
    delete device.approvedVia;
    return { value: undefined, persist: true };
  });
}

// Ages every just-approved record past the recent-approval grace window.
function prune(
  deviceId: string,
  options: Partial<Parameters<typeof pruneSupersededSilentPairedDevices>[0]> = {},
) {
  return pruneSupersededSilentPairedDevices({
    deviceId,
    baseDir,
    nowMs: Date.now() + 120_000,
    ...options,
  });
}

async function pairDevice(
  deviceId: string,
  params: {
    approvedVia?: Extract<PairedDeviceApprovalKind, "owner" | "silent" | "trusted-cidr">;
    clientId?: string;
    clientMode?: string;
    displayName?: string;
    platform?: string;
    roles?: string[];
  } = {},
) {
  const request = await requestDevicePairing(
    {
      deviceId,
      publicKey: `pk-${deviceId}`,
      clientId: params.clientId ?? "cli",
      clientMode: params.clientMode ?? "cli",
      displayName: params.displayName,
      platform: params.platform,
      role: params.roles?.[0] ?? "operator",
      roles: params.roles ?? ["operator"],
      scopes: [],
    },
    baseDir,
  );
  const approved = await approveDevicePairing(
    request.request.requestId,
    { callerScopes: [], approvedVia: params.approvedVia },
    baseDir,
  );
  if (approved?.status !== "approved") {
    throw new Error(`expected approval for ${deviceId}`);
  }
  return approved.device;
}

beforeAll(() => suiteRootTracker.setup());
afterAll(cleanupSuite);

describe("device pairing approval provenance", () => {
  test("records silent, owner, and bootstrap approval kinds", async () => {
    const silent = await pairDevice("device-silent", { approvedVia: "silent" });
    expect(silent.approvedVia).toBe("silent");

    const owner = await pairDevice("device-owner");
    expect(owner.approvedVia).toBe("owner");

    const bootstrapRequest = await requestDevicePairing(
      {
        deviceId: "device-bootstrap",
        publicKey: "pk-device-bootstrap",
        role: "node",
        roles: ["node"],
        scopes: [],
      },
      baseDir,
    );
    const bootstrapApproved = await approveBootstrapDevicePairing(
      bootstrapRequest.request.requestId,
      { roles: ["node"], scopes: [] },
      baseDir,
    );
    expect(bootstrapApproved?.status === "approved" && bootstrapApproved.device.approvedVia).toBe(
      "bootstrap",
    );
  });

  test("owner approval stays sticky across a later silent re-approve", async () => {
    await pairDevice("device-sticky");
    const repaired = await pairDevice("device-sticky", { approvedVia: "silent" });
    expect(repaired.approvedVia).toBe("owner");
  });

  test("pre-provenance records stay unknown across a later silent re-approve", async () => {
    const legacy = await pairDevice("device-legacy", { approvedVia: "silent" });
    await stripApprovalProvenance(legacy.deviceId);

    const repaired = await pairDevice("device-legacy", { approvedVia: "silent" });
    expect(repaired.approvedVia).toBeUndefined();
  });
});

describe("pruneSupersededSilentPairedDevices", () => {
  test("removes stale silent siblings from the same client cluster only", async () => {
    await pairDevice("stale-1", { approvedVia: "silent" });
    await pairDevice("stale-2", { approvedVia: "silent" });
    await pairDevice("owner-kept");
    await pairDevice("cidr-kept", { approvedVia: "trusted-cidr" });
    await pairDevice("other-cluster", {
      approvedVia: "silent",
      clientId: "node-host",
      clientMode: "node",
      displayName: "megaclaw",
    });
    const anchor = await pairDevice("anchor", { approvedVia: "silent" });

    const removed = await prune(anchor.deviceId);

    expect(removed.map((entry) => entry.deviceId).toSorted()).toEqual(["stale-1", "stale-2"]);
    expect(removed[0]?.roles).toEqual(["operator"]);
    const remaining = (await listDevicePairing(baseDir)).paired.map((device) => device.deviceId);
    expect(remaining.toSorted()).toEqual(["anchor", "cidr-kept", "other-cluster", "owner-kept"]);
  });

  test("trusted-cidr approvals never anchor a prune", async () => {
    const baseDir = await makeBaseDir();
    await pairDevice({
      baseDir,
      deviceId: "cidr-stale",
      approvedVia: "trusted-cidr",
      clientId: "node-host",
      clientMode: "node",
      displayName: "megaclaw",
    });
    const anchor = await pairDevice({
      baseDir,
      deviceId: "cidr-anchor",
      approvedVia: "trusted-cidr",
      clientId: "node-host",
      clientMode: "node",
      displayName: "megaclaw",
    });

    const removed = await pruneSupersededSilentPairedDevices({
      deviceId: anchor.deviceId,
      baseDir,
      nowMs: agedNowMs(),
    });

    expect(removed).toEqual([]);
    expect(await getPairedDevice("cidr-stale", baseDir)).not.toBeNull();
  });

  test("skips freshly approved siblings still inside the grace window", async () => {
    await pairDevice("in-flight", { approvedVia: "silent" });
    const anchor = await pairDevice("anchor", { approvedVia: "silent" });

    // Real now: the sibling was approved milliseconds ago, so a concurrent
    // handshake that has not registered its connection yet must survive.
    const removed = await prune(anchor.deviceId, { nowMs: undefined });

    expect(removed).toEqual([]);
    expect(await getPairedDevice("in-flight", baseDir)).not.toBeNull();
  });

  test("skips connected devices and drops pending requests for pruned ids", async () => {
    await pairDevice("stale", { approvedVia: "silent" });
    await pairDevice("live", { approvedVia: "silent" });
    const anchor = await pairDevice("anchor", { approvedVia: "silent" });
    // A pruned device may still have a queued repair request; it must go too.
    await requestDevicePairing(
      {
        deviceId: "stale",
        publicKey: "pk-stale-repair",
        clientId: "cli",
        clientMode: "cli",
        role: "operator",
        scopes: [],
      },
      baseDir,
    );

    const removed = await prune(anchor.deviceId, {
      protectedDeviceIds: ["live"],
      isDeviceConnected: (deviceId) => deviceId === "live",
    });

    expect(removed.map((entry) => entry.deviceId)).toEqual(["stale"]);
    const list = await listDevicePairing(baseDir);
    expect(list.paired.map((device) => device.deviceId).toSorted()).toEqual(["anchor", "live"]);
    expect(list.pending).toHaveLength(0);
  });

  test("keeps the prune batch when a candidate connects after the snapshot", async () => {
    await pairDevice("stale", { approvedVia: "silent" });
    await pairDevice("live", { approvedVia: "silent" });
    const anchor = await pairDevice("anchor", { approvedVia: "silent" });

    const removed = await prune(anchor.deviceId, {
      protectedDeviceIds: [],
      isDeviceConnected: (deviceId) => deviceId === "live",
    });

    expect(removed).toEqual([]);
    const list = await listDevicePairing(baseDir);
    expect(list.paired.map((device) => device.deviceId).toSorted()).toEqual([
      "anchor",
      "live",
      "stale",
    ]);
  });

  test("does not prune when the anchor was not silent-approved", async () => {
    await pairDevice("stale", { approvedVia: "silent" });
    const anchor = await pairDevice("anchor-owner");

    const removed = await prune(anchor.deviceId);

    expect(removed).toEqual([]);
    expect(await getPairedDevice("stale", baseDir)).not.toBeNull();
  });

  test("leaves legacy records without approval provenance untouched", async () => {
    const baseDir = await makeBaseDir();
    const legacy = await pairDevice({ baseDir, deviceId: "legacy", approvedVia: "silent" });
    await stripApprovalProvenance(baseDir, legacy.deviceId);
    const anchor = await pairDevice({ baseDir, deviceId: "anchor", approvedVia: "silent" });

    const removed = await pruneSupersededSilentPairedDevices({
      deviceId: anchor.deviceId,
      baseDir,
      nowMs: agedNowMs(),
    });

    expect(removed).toEqual([]);
    expect(await getPairedDevice("legacy", baseDir)).not.toBeNull();
  });

  test("invalidates the card renderer cache after pruning the last renderer", async () => {
    await pairDevice("stale-renderer", { approvedVia: "silent", platform: "ios" });
    const anchor = await pairDevice("anchor", { approvedVia: "silent", platform: "linux" });
    await expect(hasPairedCardRenderer(baseDir)).resolves.toBe(true);

    await prune(anchor.deviceId);

    await expect(hasPairedCardRenderer(baseDir)).resolves.toBe(false);
  });
});
