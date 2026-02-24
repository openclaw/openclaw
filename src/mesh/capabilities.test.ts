import { describe, expect, it, beforeEach } from "vitest";
import { MeshCapabilityRegistry } from "./capabilities.js";

describe("MeshCapabilityRegistry", () => {
  let registry: MeshCapabilityRegistry;

  beforeEach(() => {
    registry = new MeshCapabilityRegistry();
  });

  describe("updatePeer()", () => {
    it("stores capabilities for a deviceId", () => {
      registry.updatePeer("peer-a", ["channel:telegram", "skill:weather"]);
      expect(registry.getPeerCapabilities("peer-a")).toEqual(["channel:telegram", "skill:weather"]);
    });

    it("overwrites previous capabilities", () => {
      registry.updatePeer("peer-a", ["channel:telegram"]);
      registry.updatePeer("peer-a", ["channel:whatsapp"]);
      expect(registry.getPeerCapabilities("peer-a")).toEqual(["channel:whatsapp"]);
    });
  });

  describe("removePeer()", () => {
    it("clears capabilities for a deviceId", () => {
      registry.updatePeer("peer-a", ["channel:telegram"]);
      registry.removePeer("peer-a");
      expect(registry.getPeerCapabilities("peer-a")).toEqual([]);
    });

    it("is a no-op for unknown peer", () => {
      expect(() => registry.removePeer("unknown")).not.toThrow();
    });
  });

  describe("findPeerWithChannel()", () => {
    it("returns the correct deviceId for a channel capability", () => {
      registry.updatePeer("peer-a", ["channel:telegram", "channel:slack"]);
      registry.updatePeer("peer-b", ["channel:whatsapp"]);
      expect(registry.findPeerWithChannel("telegram")).toBe("peer-a");
      expect(registry.findPeerWithChannel("whatsapp")).toBe("peer-b");
    });

    it("returns null when no peer has the channel", () => {
      registry.updatePeer("peer-a", ["channel:telegram"]);
      expect(registry.findPeerWithChannel("discord")).toBeNull();
    });
  });

  describe("findPeerWithSkill()", () => {
    it("returns the correct deviceId for a skill capability", () => {
      registry.updatePeer("peer-a", ["skill:weather", "skill:search"]);
      expect(registry.findPeerWithSkill("weather")).toBe("peer-a");
    });

    it("returns null when no peer has the skill", () => {
      expect(registry.findPeerWithSkill("nonexistent")).toBeNull();
    });
  });

  describe("findPeersWithCapability()", () => {
    it("returns all peers with a given capability", () => {
      registry.updatePeer("peer-a", ["channel:telegram"]);
      registry.updatePeer("peer-b", ["channel:telegram", "channel:slack"]);
      registry.updatePeer("peer-c", ["channel:whatsapp"]);
      expect(registry.findPeersWithCapability("channel:telegram")).toEqual(["peer-a", "peer-b"]);
    });

    it("returns empty array when no matches", () => {
      expect(registry.findPeersWithCapability("channel:xyz")).toEqual([]);
    });
  });

  describe("getPeerCapabilities()", () => {
    it("returns array for known peer", () => {
      registry.updatePeer("peer-a", ["skill:code"]);
      expect(registry.getPeerCapabilities("peer-a")).toEqual(["skill:code"]);
    });

    it("returns empty array for unknown peer", () => {
      expect(registry.getPeerCapabilities("unknown")).toEqual([]);
    });
  });

  describe("listAll()", () => {
    it("returns full map of all peers and capabilities", () => {
      registry.updatePeer("peer-a", ["channel:telegram"]);
      registry.updatePeer("peer-b", ["skill:weather"]);
      const all = registry.listAll();
      expect(all).toHaveLength(2);
      expect(all).toEqual(
        expect.arrayContaining([
          { deviceId: "peer-a", capabilities: ["channel:telegram"] },
          { deviceId: "peer-b", capabilities: ["skill:weather"] },
        ]),
      );
    });

    it("returns empty array for empty registry", () => {
      expect(registry.listAll()).toEqual([]);
    });
  });
});
