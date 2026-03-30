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
});
