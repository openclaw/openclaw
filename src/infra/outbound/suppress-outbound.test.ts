import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { isOutboundSuppressed } from "./suppress-outbound.js";

describe("isOutboundSuppressed", () => {
  it("returns false when channel config is missing", () => {
    const cfg = {} as OpenClawConfig;
    expect(isOutboundSuppressed({ cfg, channel: "whatsapp" })).toBe(false);
  });

  it("returns false when suppressOutbound is not set", () => {
    const cfg = { channels: { whatsapp: {} } } as OpenClawConfig;
    expect(isOutboundSuppressed({ cfg, channel: "whatsapp" })).toBe(false);
  });

  it("returns true when channel-level suppressOutbound is true", () => {
    const cfg = {
      channels: { whatsapp: { suppressOutbound: true } },
    } as OpenClawConfig;
    expect(isOutboundSuppressed({ cfg, channel: "whatsapp" })).toBe(true);
  });

  it("returns false when channel-level suppressOutbound is false", () => {
    const cfg = {
      channels: { whatsapp: { suppressOutbound: false } },
    } as OpenClawConfig;
    expect(isOutboundSuppressed({ cfg, channel: "whatsapp" })).toBe(false);
  });

  it("account-level override takes precedence over channel-level", () => {
    const cfg = {
      channels: {
        whatsapp: {
          suppressOutbound: true,
          accounts: {
            work: { suppressOutbound: false },
          },
        },
      },
    } as OpenClawConfig;

    // Account override = false → not suppressed despite channel = true
    expect(isOutboundSuppressed({ cfg, channel: "whatsapp", accountId: "work" })).toBe(false);
  });

  it("account-level true overrides channel-level false", () => {
    const cfg = {
      channels: {
        whatsapp: {
          suppressOutbound: false,
          accounts: {
            work: { suppressOutbound: true },
          },
        },
      },
    } as OpenClawConfig;

    expect(isOutboundSuppressed({ cfg, channel: "whatsapp", accountId: "work" })).toBe(true);
  });

  it("falls back to channel-level when account has no suppressOutbound", () => {
    const cfg = {
      channels: {
        whatsapp: {
          suppressOutbound: true,
          accounts: {
            work: {},
          },
        },
      },
    } as OpenClawConfig;

    expect(isOutboundSuppressed({ cfg, channel: "whatsapp", accountId: "work" })).toBe(true);
  });

  it("falls back to channel-level when accountId is not in accounts map", () => {
    const cfg = {
      channels: {
        whatsapp: {
          suppressOutbound: true,
          accounts: {},
        },
      },
    } as OpenClawConfig;

    expect(isOutboundSuppressed({ cfg, channel: "whatsapp", accountId: "unknown" })).toBe(true);
  });

  it("returns false for a different channel that is not configured", () => {
    const cfg = {
      channels: { whatsapp: { suppressOutbound: true } },
    } as OpenClawConfig;

    expect(isOutboundSuppressed({ cfg, channel: "telegram" })).toBe(false);
  });

  it("handles null accountId like undefined", () => {
    const cfg = {
      channels: { whatsapp: { suppressOutbound: true } },
    } as OpenClawConfig;

    expect(isOutboundSuppressed({ cfg, channel: "whatsapp", accountId: null })).toBe(true);
  });

  it("resolves account-level override case-insensitively", () => {
    const cfg = {
      channels: {
        whatsapp: {
          suppressOutbound: false,
          accounts: {
            Work: { suppressOutbound: true },
          },
        },
      },
    } as OpenClawConfig;

    expect(isOutboundSuppressed({ cfg, channel: "whatsapp", accountId: "work" })).toBe(true);
    expect(isOutboundSuppressed({ cfg, channel: "whatsapp", accountId: "WORK" })).toBe(true);
    expect(isOutboundSuppressed({ cfg, channel: "whatsapp", accountId: "Work" })).toBe(true);
  });
});
