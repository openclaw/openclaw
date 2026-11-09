// Exercise the tunnel connect boundary with the real SQLite pairing broker.
import { EventEmitter } from "node:events";
import http, { type IncomingMessage } from "node:http";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { writeConfigFile } from "../config/config.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { listNodePairing } from "../infra/device-pairing-node.js";
import { rotateDeviceToken } from "../infra/device-pairing-tokens.js";
import {
  listDevicePairing,
  removePairedDeviceRole,
  requestDevicePairing,
  getPairedDevice,
} from "../infra/device-pairing.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { markGatewayIngressTransport } from "./ingress-attribution.js";
import { setDeviceTokenBindingOwner } from "./openclaw-id/device-token-binding.js";
import { removeNodePairings, reconcileNodePairings } from "./openclaw-id/node-pairing.js";
import {
  setOpenClawIdTunnelPrincipalLookup,
  setOpenClawIdNodeDescriptionLookup,
  setOpenClawIdTunnelPrincipalResolver,
  type OpenClawIdTunnelPrincipal,
} from "./openclaw-id/tunnel-principal.js";
import { useAuthIdentityFixture } from "./server.auth.identity-fixture.test-support.js";
import { NODE_CLIENT, openWs } from "./server.auth.test-helpers.js";
import {
  connectReq,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  testState,
} from "./test-helpers.js";

const ssh = vi.hoisted(() => vi.fn(() => null));
vi.mock("./node-pairing-ssh-verify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./node-pairing-ssh-verify.js")>()),
  startNodePairingSshVerify: ssh,
}));
installGatewayTestHooks({ scope: "suite" });
const identityPath = useAuthIdentityFixture();
const header = "x-test-node-peer";
const peers = new Map<string, OpenClawIdTunnelPrincipal>();
const description = {
  display_name: "Reviewed node",
  platform: "linux",
  commands: ["system.run"],
  caps: ["approved"],
};
let started: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
let nextPeer = 0;
function nodePeer() {
  const peerKey = `iroh:${(++nextPeer).toString(16).padStart(64, "0")}`;
  peers.set(peerKey, {
    kind: "node",
    peerKey,
    authority: { clawId: "test-claw", rootPub: "test-root", listedSeq: nextPeer },
  });
  return peerKey;
}
// Removal then a new owner approval lists the same W under a later seq.
function relist(peerKey: string) {
  const principal = peers.get(peerKey)!;
  const listedSeq = principal.authority!.listedSeq + 1000;
  peers.set(peerKey, { ...principal, authority: { ...principal.authority!, listedSeq } });
  return listedSeq;
}
beforeAll(async () => {
  vi.spyOn(http.Server.prototype, "emit").mockImplementation(function (
    this: http.Server,
    event,
    ...args: unknown[]
  ) {
    if (event === "upgrade" || event === "request") {
      const req = args[0] as IncomingMessage;
      const peerKey = req.headers[header];
      if (typeof peerKey === "string") {
        delete req.headers[header];
        markGatewayIngressTransport(req, {
          kind: "openclaw-id-tunnel",
          peerKey,
          clientIp: "fd69:726f:6800::1",
        });
      }
    }
    return EventEmitter.prototype.emit.call(this, event, ...args);
  });
  testState.gatewayAuth = undefined;
  await writeConfigFile({
    gateway: {
      auth: { mode: "token", token: "test-node-secret" },
      nodes: { pairing: { autoApproveCidrs: ["fd00::/8"] } },
    },
  });
  started = await createGatewaySuiteHarness();
  setOpenClawIdTunnelPrincipalResolver(async (key) => peers.get(key));
  setOpenClawIdTunnelPrincipalLookup((key) => peers.get(key));
  setOpenClawIdNodeDescriptionLookup((key) => (peers.has(key) ? description : undefined));
  // The service publishes its binding writer before the tunnel admits a device.
  const bindings = new Map<string, string>();
  setDeviceTokenBindingOwner({
    lookup: (deviceId, role) => bindings.get(`${deviceId}:${role}`),
    record: async (deviceId, role, peerKey) => {
      bindings.set(`${deviceId}:${role}`, peerKey);
    },
    reportMismatch: () => {},
  });
});
afterAll(async () => {
  setDeviceTokenBindingOwner(undefined);
  setOpenClawIdNodeDescriptionLookup(undefined);
  setOpenClawIdTunnelPrincipalLookup(undefined);
  setOpenClawIdTunnelPrincipalResolver(undefined);
  await started?.close();
  vi.restoreAllMocks();
});
async function connect(
  peerKey: string,
  path: string,
  commands = ["system.run"],
  caps = ["approved"],
) {
  const ws = await openWs(started.port, { [header]: peerKey });
  try {
    return await connectReq(ws, {
      client: { ...NODE_CLIENT, platform: "linux", displayName: description.display_name },
      role: "node",
      scopes: [],
      skipDefaultAuth: true,
      deviceIdentityPath: path,
      commands,
      caps,
    });
  } finally {
    ws.close();
  }
}

test("approves the reviewed subset, prompts for additions, and never re-pairs after remove/reopen", async () => {
  const peer = nodePeer();
  const path = identityPath("ocid-node-first");
  const first = await connect(peer, path);
  expect(first.ok).toBe(true);
  const deviceId = loadOrCreateDeviceIdentity({ path }).deviceId;
  const paired = await getPairedDevice(deviceId);
  expect(paired).toMatchObject({
    approvedVia: "openclaw-id-node",
    roles: ["node"],
    approvedScopes: [],
    nodeSurface: { commands: ["system.run"], caps: ["approved"] },
    tokens: { node: { approval: { approvedVia: "openclaw-id-node", peerKey: peer } } },
  });
  expect((await listNodePairing()).pending.filter((node) => node.nodeId === deviceId)).toEqual([]);
  expect(
    (await connect(peer, path, ["system.run", "system.which"], ["approved", "extra"])).ok,
  ).toBe(true);
  const pending = (await listNodePairing()).pending.find((node) => node.nodeId === deviceId);
  expect(pending).toMatchObject({
    commands: ["system.run", "system.which"],
    caps: ["approved", "extra"],
  });
  expect(pending?.silent).not.toBe(true);
  expect((await getPairedDevice(deviceId))?.nodeSurface?.commands).toEqual(["system.run"]);
  await removePairedDeviceRole({ deviceId });
  await closeOpenClawStateDatabaseAsync();
  expect((await connect(peer, path)).ok).toBe(false);
  expect(
    (await listDevicePairing()).pending.find((request) => request.deviceId === deviceId)?.silent,
  ).not.toBe(true);
  const requests = await listDevicePairing();
  const repair = requests.pending.find((request) => request.deviceId === deviceId)!;
  await approveDevicePairing(repair.requestId, { callerScopes: ["operator.admin"] });
  expect((await connect(peer, path)).ok).toBe(true);
  expect((await getPairedDevice(deviceId))?.tokens?.node?.approval?.peerKey).toBe(peer);
  // A second installation using the same admitted W also remains manual, but binds on connect.
  const secondPath = identityPath("ocid-node-manual-second");
  const secondId = loadOrCreateDeviceIdentity({ path: secondPath }).deviceId;
  expect((await connect(peer, secondPath)).ok).toBe(false);
  const secondRequest = (await listDevicePairing()).pending.find(
    (request) => request.deviceId === secondId,
  )!;
  await approveDevicePairing(secondRequest.requestId, { callerScopes: ["operator.admin"] });
  expect((await connect(peer, secondPath)).ok).toBe(true);
  expect((await removeNodePairings([peer])).toSorted()).toEqual([deviceId, secondId].toSorted());
  expect(await getPairedDevice(deviceId)).toBeNull();
  expect(await getPairedDevice(secondId)).toBeNull();
  expect(ssh).not.toHaveBeenCalled();
});

test("keeps removal manual when the first tunnel connection used an existing pairing", async () => {
  const peer = nodePeer();
  const path = identityPath("ocid-node-manual-first");
  const identity = loadOrCreateDeviceIdentity({ path });
  const { publicKeyRawBase64UrlFromPem } = await import("../infra/device-identity.js");
  const request = await requestDevicePairing({
    deviceId: identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    role: "node",
    scopes: [],
    clientMode: "node",
  });
  await approveDevicePairing(request.request.requestId, { callerScopes: ["operator.admin"] });
  expect((await connect(peer, path)).ok).toBe(true);
  expect((await getPairedDevice(identity.deviceId))?.tokens?.node?.approval?.peerKey).toBe(peer);
  await removePairedDeviceRole({ deviceId: identity.deviceId });
  await closeOpenClawStateDatabaseAsync();
  expect((await connect(peer, path)).ok).toBe(false);
  expect(await getPairedDevice(identity.deviceId)).toBeNull();
  expect(
    (await listDevicePairing()).pending.find((entry) => entry.deviceId === identity.deviceId)
      ?.silent,
  ).not.toBe(true);
  // The manual grant consumed only that listing; a newly approved listing pairs once.
  const listedSeq = relist(peer);
  expect((await connect(peer, path)).ok).toBe(true);
  expect(
    (await getPairedDevice(identity.deviceId))?.tokens?.node?.approval?.authority,
  ).toMatchObject({ listedSeq });
  await removeNodePairings([peer]);
});

test("pairs once per owner-approved listing after removal, never again under that listing", async () => {
  const peer = nodePeer();
  const path = identityPath("ocid-node-relisted");
  expect((await connect(peer, path)).ok).toBe(true);
  const deviceId = loadOrCreateDeviceIdentity({ path }).deviceId;
  await removeNodePairings([peer]);
  const listedSeq = relist(peer);
  expect((await connect(peer, path)).ok).toBe(true);
  expect(await getPairedDevice(deviceId)).toMatchObject({
    approvedVia: "openclaw-id-node",
    tokens: { node: { approval: { peerKey: peer, authority: { listedSeq } } } },
  });
  // Under the same listing: another device and a Devices-only removal both stay manual.
  expect((await connect(peer, identityPath("ocid-node-relisted-second"))).ok).toBe(false);
  await removePairedDeviceRole({ deviceId });
  await closeOpenClawStateDatabaseAsync();
  expect((await connect(peer, path)).ok).toBe(false);
  expect(await getPairedDevice(deviceId)).toBeNull();
});

test("removes only peer-granted node roles, preserving unrelated operator grants and repeat cleanup", async () => {
  const peer = nodePeer();
  const path = identityPath("ocid-node-mixed");
  expect(
    (await connect(peer, path, ["system.run", "system.which"], ["approved", "extra"])).ok,
  ).toBe(true);
  const deviceId = loadOrCreateDeviceIdentity({ path }).deviceId;
  const before = (await getPairedDevice(deviceId))!;
  expect(before.nodeSurface).toMatchObject({ commands: ["system.run"], caps: ["approved"] });
  const request = await requestDevicePairing({
    deviceId,
    publicKey: before.publicKey,
    role: "operator",
    scopes: ["operator.read"],
  });
  await approveDevicePairing(request.request.requestId, { callerScopes: ["operator.admin"] });
  const operator = (await getPairedDevice(deviceId))!.tokens!.operator;
  expect(
    (await rotateDeviceToken({ deviceId, role: "node", callerScopes: ["operator.admin"] })).ok,
  ).toBe(true);
  await expect(removeNodePairings([peer])).resolves.toEqual([deviceId]);
  await expect(removeNodePairings([peer])).resolves.toEqual([]);
  const after = (await getPairedDevice(deviceId))!;
  expect(after.roles).toEqual(["operator"]);
  expect(after.tokens?.operator).toEqual(operator);
  expect(after.tokens?.node).toBeUndefined();
  expect(after.nodeSurface).toBeUndefined();
  expect(after.pendingNodeSurface).toBeUndefined();
});

test("does not approve merged operator requests or stale principals", async () => {
  const peer = nodePeer();
  const path = identityPath("ocid-node-merged");
  const identity = loadOrCreateDeviceIdentity({ path });
  const { publicKeyRawBase64UrlFromPem } = await import("../infra/device-identity.js");
  await requestDevicePairing({
    deviceId: identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    role: "operator",
    scopes: ["operator.read"],
  });
  expect((await connect(peer, path)).ok).toBe(false);
  expect(await getPairedDevice(identity.deviceId)).toBeNull();
  const revokedPeer = nodePeer();
  const revokedPath = identityPath("ocid-node-revoked");
  const revokedIdentity = loadOrCreateDeviceIdentity({ path: revokedPath });
  // Revoke after the connect has prepared its reviewed surface, before worker admission.
  setOpenClawIdNodeDescriptionLookup((key) => {
    if (key === revokedPeer) {
      queueMicrotask(() => peers.delete(key));
    }
    return description;
  });
  try {
    expect((await connect(revokedPeer, revokedPath)).ok).toBe(false);
    expect(await getPairedDevice(revokedIdentity.deviceId)).toBeNull();
  } finally {
    setOpenClawIdNodeDescriptionLookup((key) => (peers.has(key) ? description : undefined));
  }
  expect(ssh).not.toHaveBeenCalled();
});

test("reconciles orphaned listing provenance while retaining current nodes", async () => {
  const peer = nodePeer();
  const path = identityPath("ocid-node-reconcile");
  expect((await connect(peer, path)).ok).toBe(true);
  const deviceId = loadOrCreateDeviceIdentity({ path }).deviceId;
  await expect(
    reconcileNodePairings((source) => source.authority.rootPub === "test-root"),
  ).resolves.toEqual([]);
  await expect(
    reconcileNodePairings((source) => source.authority.rootPub === "reset-root"),
  ).resolves.toEqual([deviceId]);
  expect(await getPairedDevice(deviceId)).toBeNull();
  expect((await connect(peer, path)).ok).toBe(false);
});
