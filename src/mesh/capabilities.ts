/**
 * Tracks per-peer capabilities (channels, skills, platform) and provides
 * queries for capability-based routing.
 */
export class MeshCapabilityRegistry {
  private capsByPeer = new Map<string, Set<string>>();

  /**
   * Update capabilities for a peer (replaces existing).
   */
  updatePeer(deviceId: string, capabilities: string[]): void {
    this.capsByPeer.set(deviceId, new Set(capabilities));
  }

  /**
   * Remove a peer's capabilities (e.g. on disconnect).
   */
  removePeer(deviceId: string): void {
    this.capsByPeer.delete(deviceId);
  }

  /**
   * Find a peer that has the specified channel capability.
   * Returns the first matching peer's device ID, or null.
   */
  findPeerWithChannel(channel: string): string | null {
    const cap = `channel:${channel}`;
    for (const [deviceId, caps] of this.capsByPeer) {
      if (caps.has(cap)) {
        return deviceId;
      }
    }
    return null;
  }

  /**
   * Find a peer that has the specified skill capability.
   * Returns the first matching peer's device ID, or null.
   */
  findPeerWithSkill(skill: string): string | null {
    const cap = `skill:${skill}`;
    for (const [deviceId, caps] of this.capsByPeer) {
      if (caps.has(cap)) {
        return deviceId;
      }
    }
    return null;
  }

  /**
   * Find all peers with a specific capability.
   */
  findPeersWithCapability(capability: string): string[] {
    const result: string[] = [];
    for (const [deviceId, caps] of this.capsByPeer) {
      if (caps.has(capability)) {
        result.push(deviceId);
      }
    }
    return result;
  }

  /**
   * Get all capabilities for a specific peer.
   */
  getPeerCapabilities(deviceId: string): string[] {
    const caps = this.capsByPeer.get(deviceId);
    return caps ? [...caps] : [];
  }

  /**
   * List all peers and their capabilities.
   */
  listAll(): Array<{ deviceId: string; capabilities: string[] }> {
    return [...this.capsByPeer.entries()].map(([deviceId, caps]) => ({
      deviceId,
      capabilities: [...caps],
    }));
  }
}
