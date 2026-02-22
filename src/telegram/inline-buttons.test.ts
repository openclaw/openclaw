import { describe, expect, it } from "vitest";
import {
  isTelegramInlineButtonsEnabled,
  resolveTelegramInlineButtonsScope,
  resolveTelegramTargetChatType,
} from "./inline-buttons.js";

describe("resolveTelegramTargetChatType", () => {
  it("returns 'direct' for positive numeric IDs", () => {
    expect(resolveTelegramTargetChatType("5232990709")).toBe("direct");
    expect(resolveTelegramTargetChatType("123456789")).toBe("direct");
  });

  it("returns 'group' for negative numeric IDs", () => {
    expect(resolveTelegramTargetChatType("-123456789")).toBe("group");
    expect(resolveTelegramTargetChatType("-1001234567890")).toBe("group");
  });

  it("handles telegram: prefix from normalizeTelegramMessagingTarget", () => {
    expect(resolveTelegramTargetChatType("telegram:5232990709")).toBe("direct");
    expect(resolveTelegramTargetChatType("telegram:-123456789")).toBe("group");
    expect(resolveTelegramTargetChatType("TELEGRAM:5232990709")).toBe("direct");
  });

  it("handles tg/group prefixes and topic suffixes", () => {
    expect(resolveTelegramTargetChatType("tg:5232990709")).toBe("direct");
    expect(resolveTelegramTargetChatType("telegram:group:-1001234567890")).toBe("group");
    expect(resolveTelegramTargetChatType("telegram:group:-1001234567890:topic:456")).toBe("group");
    expect(resolveTelegramTargetChatType("-1001234567890:456")).toBe("group");
  });

  it("returns 'unknown' for usernames", () => {
    expect(resolveTelegramTargetChatType("@username")).toBe("unknown");
    expect(resolveTelegramTargetChatType("telegram:@username")).toBe("unknown");
  });

  it("returns 'unknown' for empty strings", () => {
    expect(resolveTelegramTargetChatType("")).toBe("unknown");
    expect(resolveTelegramTargetChatType("   ")).toBe("unknown");
  });
});

describe("resolveTelegramInlineButtonsScope", () => {
  const baseCfg = (capabilities?: unknown) => ({
    channels: { telegram: capabilities !== undefined ? { capabilities } : {} },
  });

  it("returns 'allowlist' by default when no capabilities configured", () => {
    expect(resolveTelegramInlineButtonsScope({ cfg: baseCfg() as never, accountId: null })).toBe(
      "allowlist",
    );
  });

  it("returns 'all' for legacy array format with 'inlinebuttons'", () => {
    expect(
      resolveTelegramInlineButtonsScope({
        cfg: baseCfg(["inlinebuttons"]) as never,
        accountId: null,
      }),
    ).toBe("all");
  });

  it("returns 'all' for legacy array format with mixed-case 'inlineButtons'", () => {
    expect(
      resolveTelegramInlineButtonsScope({
        cfg: baseCfg(["inlineButtons"]) as never,
        accountId: null,
      }),
    ).toBe("all");
  });

  it("falls back to default 'allowlist' for array without 'inlinebuttons' (regression: was 'off')", () => {
    // An array that does not explicitly include 'inlinebuttons' should not silently
    // disable callback_query handling. Falling back to default preserves parity with
    // the undefined-capabilities behaviour and prevents the issue-19797 regression
    // where buttons were rendered but pressing them had no effect.
    expect(
      resolveTelegramInlineButtonsScope({
        cfg: baseCfg([]) as never,
        accountId: null,
      }),
    ).toBe("allowlist");

    expect(
      resolveTelegramInlineButtonsScope({
        cfg: baseCfg(["otherFeature"]) as never,
        accountId: null,
      }),
    ).toBe("allowlist");
  });

  it("returns configured scope from object capabilities", () => {
    expect(
      resolveTelegramInlineButtonsScope({
        cfg: baseCfg({ inlineButtons: "dm" }) as never,
        accountId: null,
      }),
    ).toBe("dm");

    expect(
      resolveTelegramInlineButtonsScope({
        cfg: baseCfg({ inlineButtons: "off" }) as never,
        accountId: null,
      }),
    ).toBe("off");

    expect(
      resolveTelegramInlineButtonsScope({
        cfg: baseCfg({ inlineButtons: "all" }) as never,
        accountId: null,
      }),
    ).toBe("all");
  });
});

describe("isTelegramInlineButtonsEnabled", () => {
  const baseCfg = (capabilities?: unknown) => ({
    channels: { telegram: capabilities !== undefined ? { capabilities } : {} },
  });

  it("returns true when no capabilities configured (default allowlist scope)", () => {
    expect(isTelegramInlineButtonsEnabled({ cfg: baseCfg() as never })).toBe(true);
  });

  it("returns true for legacy array with 'inlinebuttons'", () => {
    expect(isTelegramInlineButtonsEnabled({ cfg: baseCfg(["inlinebuttons"]) as never })).toBe(true);
  });

  it("returns true for empty capabilities array (regression: was false due to 'off' scope)", () => {
    expect(isTelegramInlineButtonsEnabled({ cfg: baseCfg([]) as never })).toBe(true);
  });

  it("returns false only when explicitly set to off via object capabilities", () => {
    expect(
      isTelegramInlineButtonsEnabled({ cfg: baseCfg({ inlineButtons: "off" }) as never }),
    ).toBe(false);
  });
});
