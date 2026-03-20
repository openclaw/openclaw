import { describe, expect, it, vi } from "vitest";
import { resolveInboundPeerIdentity } from "./routing.js";

describe("resolveInboundPeerIdentity", () => {
  it("returns canonicalPeerId when the hook resolves one", async () => {
    const result = await resolveInboundPeerIdentity({
      peerId: "U123",
      channel: "slack",
      accountId: "default",
      hookRunner: {
        hasHooks: vi.fn(() => true),
        runBeforeIdentityResolve: vi.fn(async () => ({ canonicalPeerId: "employee-123" })),
      },
    });

    expect(result).toBe("employee-123");
  });

  it("returns null when no hook is registered", async () => {
    const result = await resolveInboundPeerIdentity({
      peerId: "U123",
      channel: "slack",
      accountId: "default",
      hookRunner: {
        hasHooks: vi.fn(() => false),
        runBeforeIdentityResolve: vi.fn(),
      },
    });

    expect(result).toBeNull();
  });

  it("returns null when the hook returns undefined", async () => {
    const result = await resolveInboundPeerIdentity({
      peerId: "U123",
      channel: "slack",
      accountId: "default",
      hookRunner: {
        hasHooks: vi.fn(() => true),
        runBeforeIdentityResolve: vi.fn(async () => undefined),
      },
    });

    expect(result).toBeNull();
  });

  it("returns null when hookRunner is not provided", async () => {
    const result = await resolveInboundPeerIdentity({
      peerId: "U123",
      channel: "slack",
      accountId: "default",
    });

    expect(result).toBeNull();
  });

  it("fails open when the hook runner throws", async () => {
    const result = await resolveInboundPeerIdentity({
      peerId: "U123",
      channel: "slack",
      accountId: "default",
      hookRunner: {
        hasHooks: vi.fn(() => true),
        runBeforeIdentityResolve: vi.fn(async () => {
          throw new Error("boom");
        }),
      },
    });

    expect(result).toBeNull();
  });
});
