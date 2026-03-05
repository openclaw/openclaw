import { describe, expect, it } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import {
  addTrustedPeer,
  removeTrustedPeer,
  isTrustedPeer,
  listTrustedPeers,
  getTrustedPeer,
} from "./peer-trust.js";

describe("peer-trust store", () => {
  it("addTrustedPeer() adds a new peer and returns { added: true }", async () => {
    await withTempHome(async () => {
      const result = await addTrustedPeer({ deviceId: "device-1", displayName: "Mac" });
      expect(result).toEqual({ added: true });
    });
  });

  it("addTrustedPeer() returns { added: false } for duplicate", async () => {
    await withTempHome(async () => {
      await addTrustedPeer({ deviceId: "device-1" });
      const result = await addTrustedPeer({ deviceId: "device-1" });
      expect(result).toEqual({ added: false });
    });
  });

  it("removeTrustedPeer() returns { removed: true } for existing peer", async () => {
    await withTempHome(async () => {
      await addTrustedPeer({ deviceId: "device-1" });
      const result = await removeTrustedPeer("device-1");
      expect(result).toEqual({ removed: true });
    });
  });

  it("removeTrustedPeer() returns { removed: false } for non-existent peer", async () => {
    await withTempHome(async () => {
      const result = await removeTrustedPeer("nonexistent");
      expect(result).toEqual({ removed: false });
    });
  });

  it("isTrustedPeer() returns true for trusted peer", async () => {
    await withTempHome(async () => {
      await addTrustedPeer({ deviceId: "device-1" });
      expect(await isTrustedPeer("device-1")).toBe(true);
    });
  });

  it("isTrustedPeer() returns false for untrusted peer", async () => {
    await withTempHome(async () => {
      expect(await isTrustedPeer("unknown")).toBe(false);
    });
  });

  it("listTrustedPeers() returns all entries", async () => {
    await withTempHome(async () => {
      await addTrustedPeer({ deviceId: "device-1", displayName: "Mac" });
      await addTrustedPeer({ deviceId: "device-2", displayName: "Jetson" });
      const peers = await listTrustedPeers();
      expect(peers).toHaveLength(2);
      expect(peers.map((p) => p.deviceId)).toEqual(["device-1", "device-2"]);
    });
  });

  it("getTrustedPeer() returns specific peer details", async () => {
    await withTempHome(async () => {
      await addTrustedPeer({ deviceId: "device-1", displayName: "Mac", publicKey: "pk-1" });
      const peer = await getTrustedPeer("device-1");
      expect(peer).toBeTruthy();
      expect(peer!.deviceId).toBe("device-1");
      expect(peer!.displayName).toBe("Mac");
      expect(peer!.publicKey).toBe("pk-1");
      expect(peer!.addedAt).toBeTruthy();
    });
  });

  it("getTrustedPeer() returns null for unknown peer", async () => {
    await withTempHome(async () => {
      const peer = await getTrustedPeer("unknown");
      expect(peer).toBeNull();
    });
  });

  it("handles fresh empty state gracefully", async () => {
    await withTempHome(async () => {
      const peers = await listTrustedPeers();
      expect(peers).toEqual([]);
    });
  });
});
