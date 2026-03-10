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

describe("delivery recovery target resolution", () => {
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
