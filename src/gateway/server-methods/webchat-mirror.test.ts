import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadConfigMock, loadSessionStoreMock, resolveStorePathMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(() => ({ session: {} })),
  loadSessionStoreMock: vi.fn(() => ({})),
  resolveStorePathMock: vi.fn(() => "/tmp/session-store.json"),
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: loadConfigMock,
  };
});

vi.mock("../../config/sessions.js", () => ({
  loadSessionStore: loadSessionStoreMock,
  resolveStorePath: resolveStorePathMock,
}));

import { resolveWebchatMirrorTarget } from "./webchat-mirror.js";

describe("resolveWebchatMirrorTarget", () => {
  beforeEach(() => {
    loadConfigMock.mockClear();
    loadSessionStoreMock.mockReset();
    loadSessionStoreMock.mockReturnValue({});
    resolveStorePathMock.mockClear();
  });

  it("mirrors discord direct sessions back to user targets", () => {
    expect(
      resolveWebchatMirrorTarget({
        client: { mode: "webchat" },
        sessionKey: "agent:main:discord:direct:1234567890",
      }),
    ).toEqual({
      channel: "discord",
      to: "user:1234567890",
    });
  });

  it("prefers discord delivery context for legacy DM channel session keys", () => {
    expect(
      resolveWebchatMirrorTarget({
        client: { mode: "webchat" },
        sessionKey: "agent:main:discord:channel:1234567890",
        entry: {
          lastChannel: "discord",
          lastTo: "user:1234567890",
          lastAccountId: "default",
        },
      }),
    ).toEqual({
      channel: "discord",
      to: "user:1234567890",
      accountId: "default",
    });
  });

  it("recovers discord user targets from legacy DM channel sessions via the session store", () => {
    loadSessionStoreMock.mockReturnValue({
      "agent:main:discord:direct:1471224874327474379": {
        sessionId: "sess-1",
        updatedAt: Date.now(),
        lastChannel: "webchat",
        lastAccountId: "default",
        deliveryContext: {
          channel: "webchat",
          accountId: "default",
        },
        origin: {
          provider: "webchat",
          surface: "webchat",
          chatType: "direct",
          from: "discord:1471224874327474379",
          to: "channel:1471614728982888620",
          accountId: "default",
        },
      },
    });

    expect(
      resolveWebchatMirrorTarget({
        client: { mode: "webchat" },
        sessionKey: "agent:main:discord:channel:1471614728982888620",
        entry: {
          lastChannel: "discord",
          lastAccountId: "default",
        },
      }),
    ).toEqual({
      channel: "discord",
      to: "user:1471224874327474379",
      accountId: "default",
    });
  });
});
