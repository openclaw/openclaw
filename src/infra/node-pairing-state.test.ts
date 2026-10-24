import { beforeEach, expect, it, vi } from "vitest";
import {
  captureAuthenticatedNodePairingState,
  captureNodePairingGeneration,
} from "./device-pairing-node-state.js";
import type { PairedDevice } from "./device-pairing.js";

const mocks = vi.hoisted(() => ({ getPairedDevice: vi.fn() }));

vi.mock("./device-pairing.js", async () => {
  const actual = await vi.importActual<typeof import("./device-pairing.js")>("./device-pairing.js");
  return { ...actual, getPairedDevice: mocks.getPairedDevice };
});

const token = { token: "test-token", role: "node", scopes: [], createdAtMs: 150 };
const surface = {
  caps: ["screen"],
  commands: ["screen.snapshot"],
  permissions: { accessibility: false },
};
function pairedNode(
  overrides: Partial<PairedDevice> = {},
  tokenPatch: Partial<typeof token> & { revokedAtMs?: number } = {},
): PairedDevice {
  return {
    deviceId: "node-1",
    publicKey: "test-key",
    role: "node",
    roles: ["node", "operator"],
    tokens: { node: { ...token, ...tokenPatch } },
    createdAtMs: 100,
    approvedAtMs: 200,
    nodeSurface: { createdAtMs: 300, approvedAtMs: 400, ...surface },
    ...overrides,
  };
}

function authenticateNode(node: PairedDevice) {
  return captureAuthenticatedNodePairingState({
    nodeId: node.deviceId,
    publicKey: node.publicKey,
    token: node.tokens!.node!.token,
  });
}

function returnDevices(...devices: PairedDevice[]) {
  for (const device of devices) {
    mocks.getPairedDevice.mockResolvedValueOnce(device);
  }
}

beforeEach(() => {
  mocks.getPairedDevice.mockReset();
});

it("binds connected sessions to the public key and node token used at authentication", async () => {
  const original = pairedNode();
  returnDevices(
    original,
    { ...original, publicKey: "fake" },
    pairedNode({}, { token: "decoy-token" }),
  );

  await expect(authenticateNode(original)).resolves.toMatchObject({
    generation: { nodeId: original.deviceId },
    approvedSurface: surface,
  });
  expect(mocks.getPairedDevice).toHaveBeenCalledTimes(1);
  await expect(authenticateNode(original)).resolves.toBeNull();
  await expect(authenticateNode(original)).resolves.toBeNull();
});

it("keeps pairing identity stable when the pending surface is approved", async () => {
  const pending = pairedNode({ nodeSurface: undefined });
  const approved = pairedNode();
  returnDevices(pending, approved);
  const pendingState = await authenticateNode(pending);
  const approvedState = await authenticateNode(pending);

  expect(pendingState?.generation).toBeNull();
  expect(pendingState?.approvedSurface).toEqual({
    caps: [],
    commands: [],
    permissions: undefined,
  });
  expect(approvedState?.generation).not.toBeNull();
  expect(approvedState?.identity.key).toBe(pendingState?.identity.key);
});

it("rejects admission without an active node token or approved node surface", async () => {
  returnDevices(
    pairedNode({ tokens: undefined }),
    pairedNode({}, { revokedAtMs: 501 }),
    pairedNode({ nodeSurface: undefined }),
  );

  await expect(captureNodePairingGeneration("node-1")).resolves.toBeNull();
  await expect(captureNodePairingGeneration("node-1")).resolves.toBeNull();
  await expect(captureNodePairingGeneration("node-1")).resolves.toBeNull();
});

it("rejects admission without a durable approved node role", async () => {
  mocks.getPairedDevice.mockResolvedValueOnce(
    pairedNode({ role: "operator", roles: ["operator"] }),
  );

  await expect(captureNodePairingGeneration("node-1")).resolves.toBeNull();
});
