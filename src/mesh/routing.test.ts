import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { MeshCapabilityRegistry } from "./capabilities.js";
import { resolveMeshRoute } from "./routing.js";

// Mock getChannelPlugin to control local availability.
vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: vi.fn(() => undefined),
}));

import { getChannelPlugin } from "../channels/plugins/index.js";

describe("resolveMeshRoute()", () => {
  let capabilityRegistry: MeshCapabilityRegistry;

  beforeEach(() => {
    capabilityRegistry = new MeshCapabilityRegistry();
    // Reset mock to return undefined (no local plugin) by default.
    vi.mocked(getChannelPlugin).mockReturnValue(undefined);
  });

  it('channel available locally returns { kind: "local" }', () => {
    vi.mocked(getChannelPlugin).mockReturnValue({ id: "telegram" } as unknown as ChannelPlugin);
    const result = resolveMeshRoute({ channel: "telegram", capabilityRegistry });
    expect(result).toEqual({ kind: "local" });
  });

  it('channel on mesh peer returns { kind: "mesh", peerDeviceId }', () => {
    capabilityRegistry.updatePeer("peer-a", ["channel:telegram"]);
    const result = resolveMeshRoute({ channel: "telegram", capabilityRegistry });
    expect(result).toEqual({ kind: "mesh", peerDeviceId: "peer-a" });
  });

  it('channel unavailable anywhere returns { kind: "unavailable" }', () => {
    const result = resolveMeshRoute({ channel: "telegram", capabilityRegistry });
    expect(result).toEqual({ kind: "unavailable" });
  });

  it('local-first priority: available both locally and on mesh returns { kind: "local" }', () => {
    vi.mocked(getChannelPlugin).mockReturnValue({ id: "telegram" } as unknown as ChannelPlugin);
    capabilityRegistry.updatePeer("peer-a", ["channel:telegram"]);
    const result = resolveMeshRoute({ channel: "telegram", capabilityRegistry });
    expect(result).toEqual({ kind: "local" });
  });

  it("multiple peers with capability returns first match", () => {
    capabilityRegistry.updatePeer("peer-a", ["channel:telegram"]);
    capabilityRegistry.updatePeer("peer-b", ["channel:telegram"]);
    const result = resolveMeshRoute({ channel: "telegram", capabilityRegistry });
    expect(result).toEqual({ kind: "mesh", peerDeviceId: "peer-a" });
  });
});
