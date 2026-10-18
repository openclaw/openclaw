// Capability approvals follow the paired-device lifecycle, not the device-auth request TTL.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { approveDevicePairing } from "./device-pairing-approval.js";
import {
  approveNodePairing,
  beginNodePairingConnect,
  finalizeNodePairingCleanupClaim,
  listNodePairing,
  recordPairedNodeConnection,
  recordPairedNodeDisconnection,
  rejectNodePairing,
  requestNodePairing,
} from "./device-pairing-node.js";
import { seedNodeDevice, setupPairedNode } from "./device-pairing-node.test-support.js";
import { usePairingState } from "./device-pairing-state.test-support.js";
import {
  getPairedDevice,
  listDevicePairingReadOnly,
  removePairedDeviceRole,
  requestDevicePairing,
  updatePairedDeviceMetadata,
} from "./device-pairing.js";

const state = usePairingState("openclaw-node-pairing-lifecycle-");
let baseDir: string;
beforeEach(() => {
  baseDir = state.baseDir;
});
afterEach(() => vi.restoreAllMocks());

function agingClock() {
  const requestedAtMs = Date.now();
  const now = vi.spyOn(Date, "now").mockReturnValue(requestedAtMs);
  return () => now.mockReturnValue(requestedAtMs + 24 * 60 * 60 * 1000);
}

function requestSurface(input: Partial<Parameters<typeof requestNodePairing>[0]> = {}) {
  return requestNodePairing(
    { nodeId: "node-1", caps: ["voiceWake"], commands: ["system.run"], ...input },
    baseDir,
  );
}

function approve(requestId: string, callerScopes = ["operator.pairing", "operator.admin"]) {
  return approveNodePairing(requestId, { callerScopes }, baseDir);
}

function reopen() {
  const database = openOpenClawStateDatabase({ env: state.env });
  return closeOpenClawStateDatabaseByPathAsync(database.path);
}

test.each(["initial", "reapproval"])(
  "keeps %s capability approval pending across aged reads, writes, and database reopen",
  async (kind) => {
    if (kind === "initial") {
      await seedNodeDevice(baseDir, "node-1");
    } else {
      await setupPairedNode(baseDir);
    }
    const age = agingClock();
    const { request } = await requestSurface({ platform: "android" });
    const database = openOpenClawStateDatabase({ env: state.env });
    age();
    const expectedPending = { requestId: request.requestId, caps: ["voiceWake"] };

    expect
      .soft((await getPairedDevice("node-1", baseDir))?.pendingNodeSurface)
      .toMatchObject(expectedPending);
    expect
      .soft((await listDevicePairingReadOnly(baseDir)).paired[0]?.pendingNodeSurface)
      .toMatchObject(expectedPending);
    expect.soft((await listNodePairing(baseDir)).pending).toEqual([request]);
    await updatePairedDeviceMetadata("node-1", { displayName: "Still connected" }, baseDir);
    expect(await closeOpenClawStateDatabaseByPathAsync(database.path)).toBe(true);
    expect
      .soft((await getPairedDevice("node-1", baseDir))?.pendingNodeSurface)
      .toMatchObject(expectedPending);
    await expect
      .soft(approve(request.requestId, ["operator.pairing"]))
      .resolves.toEqual({ status: "forbidden", missingScope: "operator.admin" });
    await expect.soft(approve(request.requestId)).resolves.toMatchObject({
      requestId: request.requestId,
      node: { caps: ["voiceWake"] },
    });
    expect((await listNodePairing(baseDir)).pending).toEqual([]);
  },
);

test.each(["rejection", "successful reconnect", "node-role removal"])(
  "resolves aged capability reapproval through %s",
  async (resolution) => {
    await setupPairedNode(baseDir);
    if (resolution === "node-role removal") {
      const operator = await requestDevicePairing(
        { deviceId: "node-1", publicKey: "test-key-node-1", role: "operator", scopes: [] },
        baseDir,
      );
      await approveDevicePairing(operator.request.requestId, { callerScopes: [] }, baseDir);
    }
    const age = agingClock();
    const { request } = await requestSurface();
    age();
    expect((await listNodePairing(baseDir)).pending).toEqual([request]);
    if (resolution === "rejection") {
      await expect(rejectNodePairing(request.requestId, baseDir)).resolves.toEqual({
        requestId: request.requestId,
        nodeId: "node-1",
      });
    } else if (resolution === "successful reconnect") {
      const { cleanupClaim } = await beginNodePairingConnect("node-1", baseDir);
      await expect(
        finalizeNodePairingCleanupClaim(expectDefined(cleanupClaim, "cleanup claim")),
      ).resolves.toEqual([{ requestId: request.requestId, nodeId: "node-1" }]);
    } else {
      await expect(
        removePairedDeviceRole({ deviceId: "node-1", role: "node", baseDir }),
      ).resolves.toEqual({ deviceId: "node-1", role: "node", removedDevice: false });
    }
    expect(await reopen()).toBe(true);
    const device = await getPairedDevice("node-1", baseDir);
    expect(device?.pendingNodeSurface).toBeUndefined();
    if (resolution === "node-role removal") {
      expect(device?.roles).toEqual(["operator"]);
      expect(device?.nodeSurface).toBeUndefined();
    } else {
      expect(device?.nodeSurface?.commands).toEqual(["system.run"]);
    }
    await expect(approve(request.requestId)).resolves.toBeNull();
  },
);

test("keeps an aged capability reapproval through a recorded disconnect", async () => {
  const generation = await setupPairedNode(baseDir);
  await expect(recordPairedNodeConnection("node-1", 1_000, baseDir, generation)).resolves.toEqual({
    recorded: true,
    firstConnection: true,
  });
  const age = agingClock();
  const { request } = await requestSurface();
  age();

  await expect(
    recordPairedNodeDisconnection({
      nodeId: "node-1",
      connectedAtMs: 1_000,
      disconnectedAtMs: 2_000,
      expectedPairingGeneration: generation,
      baseDir,
    }),
  ).resolves.toEqual({ recorded: true });

  expect(await reopen()).toBe(true);
  expect((await listNodePairing(baseDir)).pending).toEqual([request]);
});

test("supersedes an aged capability request with a changed surface", async () => {
  await setupPairedNode(baseDir);
  const age = agingClock();
  const first = await requestSurface();
  age();
  const second = await requestSurface({ commands: ["system.run", "system.which"] });

  expect(second.superseded).toEqual([{ requestId: first.request.requestId, nodeId: "node-1" }]);
  expect((await listNodePairing(baseDir)).pending).toEqual([second.request]);
  await expect(approve(first.request.requestId)).resolves.toBeNull();
});
