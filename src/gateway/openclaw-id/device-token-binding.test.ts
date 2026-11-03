import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkDeviceTokenPeer,
  recordDeviceTokenPeer,
  setDeviceTokenBindingOwner,
  type DeviceTokenBindingOwner,
} from "./device-token-binding.js";

const W1 = `iroh:${"11".repeat(32)}`;
const W2 = `iroh:${"22".repeat(32)}`;

function owner(bindings: Record<string, string> = {}) {
  const reportMismatch = vi.fn();
  const value: DeviceTokenBindingOwner = {
    lookup: (deviceId, role) => bindings[`${deviceId}/${role}`],
    record: async (deviceId, role, peerKey) => {
      bindings[`${deviceId}/${role}`] = peerKey;
    },
    reportMismatch,
  };
  setDeviceTokenBindingOwner(value);
  return { reportMismatch, bindings };
}

afterEach(() => setDeviceTokenBindingOwner(undefined));

describe("device tokens bound to the authenticated endpoint key", () => {
  it("changes nothing while OpenClaw ID is off", () => {
    expect(checkDeviceTokenPeer({ deviceId: "d", role: "operator", peerKey: W2 })).toEqual({
      ok: true,
    });
  });

  it("records the key that obtained a token and accepts it from that key", async () => {
    const { bindings } = owner();
    await recordDeviceTokenPeer({ deviceId: "d", role: "operator", peerKey: W1 });
    expect(bindings).toEqual({ "d/operator": W1 });
    expect(checkDeviceTokenPeer({ deviceId: "d", role: "operator", peerKey: W1 })).toEqual({
      ok: true,
    });
  });

  // Spec section 11 #5: a token replayed from a different W is refused and logged.
  it("refuses and reports a token presented from another key", () => {
    const { reportMismatch } = owner({ "d/operator": W1 });
    expect(checkDeviceTokenPeer({ deviceId: "d", role: "operator", peerKey: W2 })).toEqual({
      ok: false,
      reason: "device-token-peer-mismatch",
    });
    expect(reportMismatch).toHaveBeenCalledWith({
      deviceId: "d",
      role: "operator",
      boundTo: W1,
      presentedFrom: W2,
    });
  });

  it("refuses a tunnel-bound token outside the tunnel, and an unbound token over it", () => {
    owner({ "d/operator": W1 });
    expect(checkDeviceTokenPeer({ deviceId: "d", role: "operator", peerKey: undefined }).ok).toBe(
      false,
    );
    expect(checkDeviceTokenPeer({ deviceId: "e", role: "operator", peerKey: W1 }).ok).toBe(false);
    expect(checkDeviceTokenPeer({ deviceId: "e", role: "operator", peerKey: undefined }).ok).toBe(
      true,
    );
  });
});
