import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveAgentIdentityMock = vi.hoisted(() => vi.fn());
const resolveAgentAvatarMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/identity.js", () => ({
  resolveAgentIdentity: (...args: unknown[]) => resolveAgentIdentityMock(...args),
}));

vi.mock("../../agents/identity-avatar.js", () => ({
  resolveAgentAvatar: (...args: unknown[]) => resolveAgentAvatarMock(...args),
}));

type IdentityModule = typeof import("./identity.js");

let normalizeOutboundIdentity: IdentityModule["normalizeOutboundIdentity"];
let resolveAgentOutboundIdentity: IdentityModule["resolveAgentOutboundIdentity"];

beforeEach(async () => {
  vi.resetModules();
  ({ normalizeOutboundIdentity, resolveAgentOutboundIdentity } = await import("./identity.js"));
});

describe("normalizeOutboundIdentity", () => {
  it("trims fields and drops empty identities", () => {
    expect(
      normalizeOutboundIdentity({
        name: "  Demo Bot  ",
        avatarUrl: " https://example.com/a.png ",
        emoji: "  🤖  ",
        theme: "  ocean  ",
      }),
    ).toEqual({
      name: "Demo Bot",
      avatarUrl: "https://example.com/a.png",
      emoji: "🤖",
      theme: "ocean",
    });
    expect(
      normalizeOutboundIdentity({
        name: "  ",
        avatarUrl: "\n",
        emoji: "",
      }),
    ).toBeUndefined();
  });
});

describe("resolveAgentOutboundIdentity", () => {
  it("builds normalized identity data and keeps only remote avatars", () => {
    resolveAgentIdentityMock.mockReturnValueOnce({
      name: "  Agent Smith  ",
      emoji: "  🕶️  ",
      theme: "  noir  ",
    });
    resolveAgentAvatarMock.mockReturnValueOnce({
      kind: "remote",
      url: "https://example.com/avatar.png",
    });

    expect(resolveAgentOutboundIdentity({} as never, "main")).toEqual({
      name: "Agent Smith",
      emoji: "🕶️",
      avatarUrl: "https://example.com/avatar.png",
      theme: "noir",
    });
  });

  it("drops blank and non-remote avatar values after normalization", () => {
    resolveAgentIdentityMock.mockReturnValueOnce({
      name: "   ",
      emoji: "",
    });
    resolveAgentAvatarMock.mockReturnValueOnce({
      kind: "data",
      dataUrl: "data:image/png;base64,abc",
    });

    expect(resolveAgentOutboundIdentity({} as never, "main")).toBeUndefined();
  });

  it("drops blank remote avatar urls while keeping other identity fields", () => {
    resolveAgentIdentityMock.mockReturnValueOnce({
      name: "  Agent Smith  ",
      emoji: "  🕶️  ",
    });
    resolveAgentAvatarMock.mockReturnValueOnce({
      kind: "remote",
      url: "   ",
    });

    expect(resolveAgentOutboundIdentity({} as never, "main")).toEqual({
      name: "Agent Smith",
      emoji: "🕶️",
    });
  });
});
