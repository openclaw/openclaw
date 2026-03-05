import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config/config.js";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

const { defaultRouteConfig } = vi.hoisted(() => ({
  defaultRouteConfig: {
    agents: {
      list: [{ id: "main", default: true }],
    },
    channels: { telegram: {} },
    messages: { groupChat: { mentionPatterns: [] } },
  },
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: vi.fn(() => defaultRouteConfig),
  };
});

describe("buildTelegramMessageContext multi-account defaults", () => {
  beforeEach(() => {
    vi.mocked(loadConfig).mockReturnValue(defaultRouteConfig as never);
  });

  it("blocks inbound DMs for non-default accounts without explicit bindings", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      accountId: "jarvis2",
      message: {
        chat: { id: 99_001, type: "private" },
        from: { id: 41, first_name: "Guido" },
        text: "/ping",
      },
    });

    expect(ctx).toBeNull();
  });

  it("blocks non-default account when default account is disabled", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      ...defaultRouteConfig,
      channels: {
        telegram: {
          accounts: {
            default: { enabled: false },
            jarvis2: { enabled: true },
          },
          defaultAccount: "default",
        },
      },
    } as never);

    const ctx = await buildTelegramMessageContextForTest({
      accountId: "jarvis2",
      message: {
        chat: { id: 99_002, type: "private" },
        from: { id: 42, first_name: "Alex" },
        text: "hello",
      },
    });

    expect(ctx).toBeNull();
  });

  it("blocks non-default account when defaultAccount points to a missing id", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      ...defaultRouteConfig,
      channels: {
        telegram: {
          accounts: {
            brainstorm: { enabled: true },
          },
          defaultAccount: "missing",
        },
      },
    } as never);

    const ctx = await buildTelegramMessageContextForTest({
      accountId: "brainstorm",
      message: {
        chat: { id: 99_003, type: "private" },
        from: { id: 43, first_name: "Maya" },
        text: "hello",
      },
    });

    expect(ctx).toBeNull();
  });
});
