import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resolveAgentIdentityMock = vi.hoisted(() => vi.fn());
const resolveAgentAvatarMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/identity.js", () => ({
  resolveAgentIdentity: (...args: unknown[]) => resolveAgentIdentityMock(...args),
}));

vi.mock("../../agents/identity-avatar.js", () => ({
  resolveAgentAvatar: (...args: unknown[]) => resolveAgentAvatarMock(...args),
}));

type IdentityModule = typeof import("./identity.js");

let resolveAgentOutboundIdentity: IdentityModule["resolveAgentOutboundIdentity"];

beforeAll(async () => {
  ({ resolveAgentOutboundIdentity } = await import("./identity.js"));
});

beforeEach(() => {
  resolveAgentIdentityMock.mockReset();
  resolveAgentAvatarMock.mockReset();
});

describe("resolveAgentOutboundIdentity", () => {
  it.each([
    {
      identity: {
        name: "  Agent Smith  ",
        emoji: "  🕶️  ",
        theme: "  noir  ",
      },
      avatar: {
        kind: "remote",
        url: " https://example.com/avatar.png ",
      },
      expected: {
        name: "Agent Smith",
        emoji: "🕶️",
        avatarUrl: "https://example.com/avatar.png",
        theme: "noir",
      },
    },
    {
      identity: {
        name: "   ",
        emoji: "",
      },
      avatar: {
        kind: "data",
        dataUrl: "data:image/png;base64,abc",
      },
      expected: undefined,
    },
    {
      identity: {
        name: "  Agent Smith  ",
        emoji: "  🕶️  ",
      },
      avatar: {
        kind: "remote",
        url: "   ",
      },
      expected: {
        name: "Agent Smith",
        emoji: "🕶️",
      },
    },
    {
      identity: { name: "  ", emoji: "" },
      avatar: { kind: "remote", url: "\n" },
      expected: undefined,
    },
  ])("resolves outbound identity for %j", ({ identity, avatar, expected }) => {
    resolveAgentIdentityMock.mockReturnValueOnce(identity);
    resolveAgentAvatarMock.mockReturnValueOnce(avatar);
    expect(resolveAgentOutboundIdentity({} as never, "main")).toEqual(expected);
  });
});
