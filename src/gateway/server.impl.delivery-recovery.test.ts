import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const hoisted = vi.hoisted(() => ({
  normalizeChannelId: vi.fn<(raw?: string | null) => string | null>(),
  getChannelPlugin: vi.fn(),
  resolveChannelDefaultAccountId: vi.fn(),
}));

vi.mock("../channels/plugins/index.js", () => ({
  normalizeChannelId: hoisted.normalizeChannelId,
  getChannelPlugin: hoisted.getChannelPlugin,
  listChannelPlugins: vi.fn(() => []),
}));

vi.mock("../channels/plugins/helpers.js", () => ({
  resolveChannelDefaultAccountId: hoisted.resolveChannelDefaultAccountId,
}));

import { __testing } from "./server.impl.js";

beforeEach(() => {
  hoisted.normalizeChannelId.mockReset();
  hoisted.getChannelPlugin.mockReset();
  hoisted.resolveChannelDefaultAccountId.mockReset();

  hoisted.normalizeChannelId.mockImplementation((raw?: string | null) => {
    if (typeof raw !== "string") {
      return null;
    }
    const trimmed = raw.trim();
    return trimmed ? trimmed : null;
  });
});

describe("delivery recovery target resolution", () => {
  it("skips legacy entries without accountId when channel has no configured accounts", () => {
    hoisted.getChannelPlugin.mockReturnValue({
      id: "synologychat",
      config: {
        listAccountIds: () => [],
      },
    });
    hoisted.resolveChannelDefaultAccountId.mockReturnValue("default");

    const targets = __testing.resolvePendingDeliveryRecoveryTargets({
      pending: [{ channel: "synologychat" }],
      cfg: {} as OpenClawConfig,
    });

    expect(targets).toEqual([]);
  });

  it("uses configured default account for legacy entries when accounts exist", () => {
    hoisted.getChannelPlugin.mockReturnValue({
      id: "whatsapp",
      config: {
        listAccountIds: () => ["default", "backup"],
      },
    });
    hoisted.resolveChannelDefaultAccountId.mockReturnValue("default");

    const targets = __testing.resolvePendingDeliveryRecoveryTargets({
      pending: [{ channel: "whatsapp" }],
      cfg: {} as OpenClawConfig,
    });

    expect(targets).toEqual([{ channel: "whatsapp", accountId: "default" }]);
  });

  it("skips explicit stale account ids removed from config", () => {
    hoisted.getChannelPlugin.mockReturnValue({
      id: "whatsapp",
      config: {
        listAccountIds: () => ["live"],
      },
    });

    const targets = __testing.resolvePendingDeliveryRecoveryTargets({
      pending: [{ channel: "whatsapp", accountId: "removed" }],
      cfg: {} as OpenClawConfig,
    });

    expect(targets).toEqual([]);
  });
});

describe("delivery recovery preflight skip mode", () => {
  it("skips readiness preflight when OPENCLAW_SKIP_CHANNELS is enabled", () => {
    expect(
      __testing.shouldSkipDeliveryRecoveryReadinessPreflight({ OPENCLAW_SKIP_CHANNELS: "1" }),
    ).toBe(true);
  });

  it("skips readiness preflight when OPENCLAW_SKIP_PROVIDERS is enabled", () => {
    expect(
      __testing.shouldSkipDeliveryRecoveryReadinessPreflight({ OPENCLAW_SKIP_PROVIDERS: "true" }),
    ).toBe(true);
  });

  it("does not skip readiness preflight when both flags are disabled", () => {
    expect(
      __testing.shouldSkipDeliveryRecoveryReadinessPreflight({
        OPENCLAW_SKIP_CHANNELS: "0",
        OPENCLAW_SKIP_PROVIDERS: "false",
      }),
    ).toBe(false);
  });
});
