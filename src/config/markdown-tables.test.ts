import { describe, expect, it } from "vitest";
import { DEFAULT_TABLE_MODES, resolveMarkdownTableMode } from "./markdown-tables.js";

describe("DEFAULT_TABLE_MODES", () => {
  it("mattermost mode is off", () => {
    expect(DEFAULT_TABLE_MODES.get("mattermost")).toBe("off");
  });

  it("signal mode is bullets", () => {
    expect(DEFAULT_TABLE_MODES.get("signal")).toBe("bullets");
  });

  it("whatsapp mode is bullets", () => {
    expect(DEFAULT_TABLE_MODES.get("whatsapp")).toBe("bullets");
  });

  it("slack mode is block", () => {
    expect(DEFAULT_TABLE_MODES.get("slack")).toBe("block");
  });
});

describe("resolveMarkdownTableMode", () => {
  it("defaults to block for slack", () => {
    expect(resolveMarkdownTableMode({ channel: "slack" })).toBe("block");
  });

  it("defaults to code for channels without an explicit default", () => {
    expect(resolveMarkdownTableMode({ channel: "telegram" })).toBe("code");
  });

  it("coerces block to code for non-slack channels", () => {
    const cfg = { channels: { telegram: { markdown: { tables: "block" as const } } } };
    expect(resolveMarkdownTableMode({ cfg, channel: "telegram" })).toBe("code");
  });

  it("preserves block mode for slack", () => {
    const cfg = { channels: { slack: { markdown: { tables: "block" as const } } } };
    expect(resolveMarkdownTableMode({ cfg, channel: "slack" })).toBe("block");
  });
});
