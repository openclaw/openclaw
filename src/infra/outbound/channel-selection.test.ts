import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { listEnabledAccountIds, resolveMessageAccountSelection } from "./channel-selection.js";

// Mock the channel plugins
vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: () => [
    {
      id: "whatsapp",
      config: {
        listAccountIds: (cfg: OpenClawConfig) => {
          const accounts = (cfg.channels?.whatsapp as Record<string, unknown>)?.accounts;
          if (!accounts || typeof accounts !== "object") {
            return ["default"];
          }
          return Object.keys(accounts as Record<string, unknown>);
        },
        resolveAccount: (cfg: OpenClawConfig, accountId: string) => {
          const accounts = (cfg.channels?.whatsapp as Record<string, unknown>)?.accounts as
            | Record<string, unknown>
            | undefined;
          return accounts?.[accountId] ?? {};
        },
        isEnabled: undefined,
      },
    },
  ],
}));

describe("listEnabledAccountIds", () => {
  it("returns enabled accounts only", () => {
    const cfg = {
      channels: {
        whatsapp: {
          accounts: {
            default: { enabled: false },
            xiaomi: { enabled: true },
            backup: {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = listEnabledAccountIds({ cfg, channel: "whatsapp" });
    expect(result).toEqual(["xiaomi", "backup"]);
  });

  it("returns all accounts when none explicitly disabled", () => {
    const cfg = {
      channels: {
        whatsapp: {
          accounts: {
            default: {},
            other: {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = listEnabledAccountIds({ cfg, channel: "whatsapp" });
    expect(result).toEqual(["default", "other"]);
  });

  it("returns null for unknown channels", () => {
    const cfg = {} as OpenClawConfig;
    const result = listEnabledAccountIds({ cfg, channel: "unknown" as never });
    expect(result).toBeNull();
  });
});

describe("resolveMessageAccountSelection", () => {
  it("uses provided accountId directly", () => {
    const cfg = {
      channels: {
        whatsapp: {
          accounts: {
            default: { enabled: false },
            xiaomi: { enabled: true },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveMessageAccountSelection({
      cfg,
      channel: "whatsapp",
      accountId: "custom",
    });
    expect(result).toBe("custom");
  });

  it("uses default account when enabled", () => {
    const cfg = {
      channels: {
        whatsapp: {
          accounts: {
            default: { enabled: true },
            other: { enabled: true },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveMessageAccountSelection({
      cfg,
      channel: "whatsapp",
    });
    expect(result).toBe("default");
  });

  it("auto-selects single enabled account when default is disabled", () => {
    const cfg = {
      channels: {
        whatsapp: {
          accounts: {
            default: { enabled: false },
            xiaomi: { enabled: true },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveMessageAccountSelection({
      cfg,
      channel: "whatsapp",
    });
    expect(result).toBe("xiaomi");
  });

  it("throws when multiple accounts enabled and no explicit selection", () => {
    const cfg = {
      channels: {
        whatsapp: {
          accounts: {
            default: { enabled: false },
            xiaomi: { enabled: true },
            backup: { enabled: true },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(() =>
      resolveMessageAccountSelection({
        cfg,
        channel: "whatsapp",
      }),
    ).toThrow(/Multiple accounts enabled.*xiaomi.*backup/);
  });

  it("throws when no accounts are enabled", () => {
    const cfg = {
      channels: {
        whatsapp: {
          accounts: {
            default: { enabled: false },
            other: { enabled: false },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(() =>
      resolveMessageAccountSelection({
        cfg,
        channel: "whatsapp",
      }),
    ).toThrow(/No enabled accounts/);
  });

  it("falls back to default when plugin not found", () => {
    const cfg = {} as OpenClawConfig;
    const result = resolveMessageAccountSelection({
      cfg,
      channel: "unknown" as never,
    });
    expect(result).toBe("default");
  });

  it("falls back to defaultAccountId when plugin not found", () => {
    const cfg = {} as OpenClawConfig;
    const result = resolveMessageAccountSelection({
      cfg,
      channel: "unknown" as never,
      defaultAccountId: "custom",
    });
    expect(result).toBe("custom");
  });
});
