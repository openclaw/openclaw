import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkDeviceTokenPeer,
  recordDeviceTokenPeer,
  setDeviceTokenBindingOwner,
  setDeviceTokenBindingsLoading,
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

afterEach(() => {
  setDeviceTokenBindingOwner(undefined);
  setDeviceTokenBindingsLoading(Promise.resolve());
});

describe("device tokens bound to the authenticated endpoint key", () => {
  it("changes nothing while no bindings are published", async () => {
    expect(await checkDeviceTokenPeer({ deviceId: "d", role: "operator", peerKey: W2 })).toEqual({
      ok: true,
    });
  });

  it("records the key that obtained a token and accepts it from that key", async () => {
    const { bindings } = owner();
    await recordDeviceTokenPeer({ deviceId: "d", role: "operator", peerKey: W1 });
    expect(bindings).toEqual({ "d/operator": W1 });
    expect(await checkDeviceTokenPeer({ deviceId: "d", role: "operator", peerKey: W1 })).toEqual({
      ok: true,
    });
  });

  // Spec section 11 #5: a token replayed from a different W is refused and logged.
  it("refuses and reports a token presented from another key", async () => {
    const { reportMismatch } = owner({ "d/operator": W1 });
    expect(await checkDeviceTokenPeer({ deviceId: "d", role: "operator", peerKey: W2 })).toEqual({
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

  it("refuses a tunnel-bound token outside the tunnel, and an unbound token over it", async () => {
    owner({ "d/operator": W1 });
    const ok = async (deviceId: string, peerKey: string | undefined) =>
      (await checkDeviceTokenPeer({ deviceId, role: "operator", peerKey })).ok;
    expect(await ok("d", undefined)).toBe(false);
    expect(await ok("e", W1)).toBe(false);
    expect(await ok("e", undefined)).toBe(true);
  });

  it("holds checks until the Gateway-start binding read settles", async () => {
    let finish = () => {};
    setDeviceTokenBindingsLoading(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const check = checkDeviceTokenPeer({ deviceId: "d", role: "operator", peerKey: undefined });
    owner({ "d/operator": W1 });
    finish();
    await expect(check).resolves.toEqual({ ok: false, reason: "device-token-peer-mismatch" });
  });

  it("fails token checks closed while the authority cannot reconcile a write", async () => {
    setDeviceTokenBindingOwner({
      lookup: () => {
        throw new Error("uncertain storage outcome");
      },
      record: async () => {},
      reportMismatch: vi.fn(),
    });
    expect(
      await checkDeviceTokenPeer({ deviceId: "e", role: "operator", peerKey: undefined }),
    ).toEqual({ ok: false, reason: "device-token-bindings-unreadable" });
  });

  it("refuses every device token while the saved bindings are unreadable", async () => {
    setDeviceTokenBindingOwner("unreadable");
    expect(
      await checkDeviceTokenPeer({ deviceId: "e", role: "operator", peerKey: undefined }),
    ).toEqual({
      ok: false,
      reason: "device-token-bindings-unreadable",
    });
    await recordDeviceTokenPeer({ deviceId: "e", role: "operator", peerKey: W1 });
  });
});
