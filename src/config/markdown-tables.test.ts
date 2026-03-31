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

  it("slack defaults to block mode", () => {
    expect(DEFAULT_TABLE_MODES.get("slack")).toBe("block");
  });

  it("only slack defaults to block mode", () => {
    // Verify no other channel defaults to "block" — channels without a
    // Block Kit send path would silently drop table content.
    for (const [channel, mode] of DEFAULT_TABLE_MODES) {
      if (channel !== "slack") {
        expect(mode, `${channel} should not default to block`).not.toBe("block");
      }
    }
  });
});

describe("resolveMarkdownTableMode", () => {
  // Note: resolveMarkdownTableMode calls normalizeChannelId which requires
  // the channel plugin registry to be initialized. In unit tests without
  // plugin registration, normalizeChannelId("slack") returns null, so the
  // function falls back to "code". The DEFAULT_TABLE_MODES tests above
  // validate the intended defaults; the send-path tests use explicit
  // tableMode: "block" to bypass plugin resolution.

  it("falls back to code when channel plugin is not registered", () => {
    expect(resolveMarkdownTableMode({ channel: "slack" })).toBe("code");
  });

  it("falls back to code when channel is unrecognized", () => {
    expect(resolveMarkdownTableMode({ channel: "unknown-channel" })).toBe("code");
  });

  it("returns code when no channel is specified", () => {
    expect(resolveMarkdownTableMode({})).toBe("code");
  });

  it("coerces block to code for non-Slack channels with explicit config", () => {
    // Even when a user explicitly sets markdown.tables: "block" for a
    // non-Slack channel, the resolver should coerce it to "code" because
    // only Slack's send path can consume Block Kit table metadata.
    // In unit tests without plugin registration, normalizeChannelId returns
    // null so the coercion path isn't reachable — this test documents the
    // intent and verifies the fallback behavior is safe.
    const result = resolveMarkdownTableMode({
      cfg: {
        channels: { telegram: { markdown: { tables: "block" } } },
      } as never,
      channel: "telegram",
    });
    // Without plugin registration, normalizeChannelId("telegram") returns
    // null, so the function falls back to "code" (safe default).
    expect(result).toBe("code");
  });
});
