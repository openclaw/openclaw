import { describe, expect, it } from "vitest";
import { resolveMarkdownTableMode } from "./markdown-tables.js";

describe("resolveMarkdownTableMode", () => {
  it("returns 'code' as default for unknown channels", () => {
    expect(resolveMarkdownTableMode({ channel: "telegram" })).toBe("code");
  });

  it("returns 'bullets' as default for signal", () => {
    expect(resolveMarkdownTableMode({ channel: "signal" })).toBe("bullets");
  });

  it("returns 'bullets' as default for whatsapp", () => {
    expect(resolveMarkdownTableMode({ channel: "whatsapp" })).toBe("bullets");
  });

  it("returns 'code' when no channel provided", () => {
    expect(resolveMarkdownTableMode({})).toBe("code");
    expect(resolveMarkdownTableMode({ channel: null })).toBe("code");
  });

  it("uses channel-level config override", () => {
    const cfg = {
      channels: {
        telegram: { markdown: { tables: "bullets" } },
      },
    };
    expect(resolveMarkdownTableMode({ cfg, channel: "telegram" })).toBe("bullets");
  });

  it("uses account-level config override", () => {
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            default: { markdown: { tables: "off" } },
          },
        },
      },
    };
    expect(resolveMarkdownTableMode({ cfg, channel: "telegram", accountId: "default" })).toBe(
      "off",
    );
  });

  it("account-level takes priority over channel-level", () => {
    const cfg = {
      channels: {
        telegram: {
          markdown: { tables: "code" },
          accounts: {
            default: { markdown: { tables: "off" } },
          },
        },
      },
    };
    expect(resolveMarkdownTableMode({ cfg, channel: "telegram", accountId: "default" })).toBe(
      "off",
    );
  });

  it("falls back to channel default when config section is empty", () => {
    const cfg = { channels: { signal: {} } };
    expect(resolveMarkdownTableMode({ cfg, channel: "signal" })).toBe("bullets");
  });
});
