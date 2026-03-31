import { describe, expect, it } from "vitest";
import {
  isDiscordMutableAllowEntry,
  isSlackMutableAllowEntry,
  isGoogleChatMutableAllowEntry,
  isMSTeamsMutableAllowEntry,
  isMattermostMutableAllowEntry,
  isIrcMutableAllowEntry,
  isZalouserMutableGroupEntry,
} from "./mutable-allowlist-detectors.js";

describe("isDiscordMutableAllowEntry", () => {
  it("returns false for empty, whitespace, and wildcard inputs", () => {
    expect(isDiscordMutableAllowEntry("")).toBe(false);
    expect(isDiscordMutableAllowEntry("  ")).toBe(false);
    expect(isDiscordMutableAllowEntry("*")).toBe(false);
  });

  it("returns false for numeric snowflake IDs", () => {
    expect(isDiscordMutableAllowEntry("123456789012345678")).toBe(false);
    expect(isDiscordMutableAllowEntry("0")).toBe(false);
  });

  it("returns false for mention-style IDs (<@id> and <@!id>)", () => {
    expect(isDiscordMutableAllowEntry("<@123456789>")).toBe(false);
    expect(isDiscordMutableAllowEntry("<@!987654321>")).toBe(false);
  });

  it("returns true for known prefixes followed by nothing (prefix-only is mutable)", () => {
    expect(isDiscordMutableAllowEntry("discord:")).toBe(true);
    expect(isDiscordMutableAllowEntry("user:")).toBe(true);
    expect(isDiscordMutableAllowEntry("pk:")).toBe(true);
    expect(isDiscordMutableAllowEntry("discord:   ")).toBe(true);
  });

  it("returns true for mutable display names", () => {
    expect(isDiscordMutableAllowEntry("alice")).toBe(true);
    expect(isDiscordMutableAllowEntry("Bob The Builder")).toBe(true);
  });

  it("returns false for prefixed entries with non-empty values (treated as IDs)", () => {
    expect(isDiscordMutableAllowEntry("discord:alice")).toBe(false);
    expect(isDiscordMutableAllowEntry("user:bob")).toBe(false);
    expect(isDiscordMutableAllowEntry("pk:charlie")).toBe(false);
  });

  it("returns true for non-numeric mention-like strings", () => {
    expect(isDiscordMutableAllowEntry("<@alice>")).toBe(true);
  });
});

describe("isSlackMutableAllowEntry", () => {
  it("returns false for empty, whitespace, and wildcard inputs", () => {
    expect(isSlackMutableAllowEntry("")).toBe(false);
    expect(isSlackMutableAllowEntry("  ")).toBe(false);
    expect(isSlackMutableAllowEntry("*")).toBe(false);
  });

  it("returns false for mention-style Slack user IDs", () => {
    expect(isSlackMutableAllowEntry("<@U12345678>")).toBe(false);
    expect(isSlackMutableAllowEntry("<@W0ABCDEFGH>")).toBe(false);
  });

  it("returns false for bare Slack-style IDs (U/W/B/... prefix + alphanumeric)", () => {
    expect(isSlackMutableAllowEntry("U12345678")).toBe(false);
    expect(isSlackMutableAllowEntry("W0ABCDEF")).toBe(false);
    expect(isSlackMutableAllowEntry("BABCDEFGHI")).toBe(false);
  });

  it("returns false for prefixed Slack IDs", () => {
    expect(isSlackMutableAllowEntry("slack:U12345678")).toBe(false);
    expect(isSlackMutableAllowEntry("user:W0ABCDEF")).toBe(false);
  });

  it("returns false for long alphanumeric IDs (8+ chars)", () => {
    expect(isSlackMutableAllowEntry("ABCDEFGH")).toBe(false);
    expect(isSlackMutableAllowEntry("slack:abcdefghij")).toBe(false);
  });

  it("returns true for mutable display names", () => {
    expect(isSlackMutableAllowEntry("alice")).toBe(true);
    expect(isSlackMutableAllowEntry("Bob Smith")).toBe(true);
  });

  it("returns true for short alphanumeric strings that are not valid IDs", () => {
    expect(isSlackMutableAllowEntry("ABC")).toBe(true);
  });
});

describe("isGoogleChatMutableAllowEntry", () => {
  it("returns false for empty, whitespace, and wildcard inputs", () => {
    expect(isGoogleChatMutableAllowEntry("")).toBe(false);
    expect(isGoogleChatMutableAllowEntry("  ")).toBe(false);
    expect(isGoogleChatMutableAllowEntry("*")).toBe(false);
  });

  it("returns false for prefix-only entries", () => {
    expect(isGoogleChatMutableAllowEntry("googlechat:")).toBe(false);
    expect(isGoogleChatMutableAllowEntry("google-chat:")).toBe(false);
    expect(isGoogleChatMutableAllowEntry("gchat:")).toBe(false);
    expect(isGoogleChatMutableAllowEntry("gchat:  ")).toBe(false);
  });

  it("returns false for numeric user IDs without @", () => {
    expect(isGoogleChatMutableAllowEntry("googlechat:users/12345")).toBe(false);
    expect(isGoogleChatMutableAllowEntry("googlechat:12345")).toBe(false);
  });

  it("returns true for email-style entries (containing @)", () => {
    expect(isGoogleChatMutableAllowEntry("alice@example.com")).toBe(true);
    expect(isGoogleChatMutableAllowEntry("googlechat:alice@example.com")).toBe(true);
    expect(isGoogleChatMutableAllowEntry("gchat:users/alice@corp.com")).toBe(true);
  });
});

describe("isMSTeamsMutableAllowEntry", () => {
  it("returns false for empty, whitespace, and wildcard inputs", () => {
    expect(isMSTeamsMutableAllowEntry("")).toBe(false);
    expect(isMSTeamsMutableAllowEntry("  ")).toBe(false);
    expect(isMSTeamsMutableAllowEntry("*")).toBe(false);
  });

  it("returns false for compact IDs without spaces or @", () => {
    expect(isMSTeamsMutableAllowEntry("29:abc123def456")).toBe(false);
    expect(isMSTeamsMutableAllowEntry("msteams:abc123")).toBe(false);
  });

  it("returns true for entries with spaces (display names)", () => {
    expect(isMSTeamsMutableAllowEntry("Alice Smith")).toBe(true);
    expect(isMSTeamsMutableAllowEntry("msteams:Alice Smith")).toBe(true);
  });

  it("returns true for entries with @ (email-like)", () => {
    expect(isMSTeamsMutableAllowEntry("alice@contoso.com")).toBe(true);
    expect(isMSTeamsMutableAllowEntry("user:alice@contoso.com")).toBe(true);
  });
});

describe("isMattermostMutableAllowEntry", () => {
  it("returns false for empty, whitespace, and wildcard inputs", () => {
    expect(isMattermostMutableAllowEntry("")).toBe(false);
    expect(isMattermostMutableAllowEntry("  ")).toBe(false);
    expect(isMattermostMutableAllowEntry("*")).toBe(false);
  });

  it("returns false for 26-char Mattermost user IDs", () => {
    expect(isMattermostMutableAllowEntry("abcdefghijklmnopqrstuvwxyz")).toBe(false);
    expect(isMattermostMutableAllowEntry("a1b2c3d4e5f6g7h8i9j0k1l2m3")).toBe(false);
    // @ prefix is stripped before checking, so 26-char value after @ is immutable
    expect(isMattermostMutableAllowEntry("@abcdefghijklmnopqrstuvwxyz")).toBe(false);
  });

  it("returns false for prefixed 26-char IDs", () => {
    // "mattermost:" prefix stripped, then 26-char alphanumeric = immutable
    expect(isMattermostMutableAllowEntry("mattermost:abcdefghijklmnopqrstuvwxyz")).toBe(false);
    expect(isMattermostMutableAllowEntry("user:abcdefghijklmnopqrstuvwxyz")).toBe(false);
  });

  it("returns true for mutable usernames", () => {
    expect(isMattermostMutableAllowEntry("alice")).toBe(true);
    expect(isMattermostMutableAllowEntry("@bob")).toBe(true);
    expect(isMattermostMutableAllowEntry("mattermost:charlie")).toBe(true);
  });

  it("returns true for IDs that are not exactly 26 chars", () => {
    expect(isMattermostMutableAllowEntry("abcdef")).toBe(true);
    expect(isMattermostMutableAllowEntry("abcdefghijklmnopqrstuvwxyz1")).toBe(true);
  });
});

describe("isIrcMutableAllowEntry", () => {
  it("returns false for empty, whitespace, and wildcard inputs", () => {
    expect(isIrcMutableAllowEntry("")).toBe(false);
    expect(isIrcMutableAllowEntry("  ")).toBe(false);
    expect(isIrcMutableAllowEntry("*")).toBe(false);
  });

  it("returns false for hostmask entries (containing ! or @)", () => {
    expect(isIrcMutableAllowEntry("nick!user@host")).toBe(false);
    expect(isIrcMutableAllowEntry("alice!~alice@192.168.1.1")).toBe(false);
  });

  it("returns false for entries with only @ (ident@host style)", () => {
    expect(isIrcMutableAllowEntry("user@irc.example.com")).toBe(false);
  });

  it("returns false for prefixed hostmask entries", () => {
    expect(isIrcMutableAllowEntry("irc:nick!user@host")).toBe(false);
    expect(isIrcMutableAllowEntry("user:nick!ident@host")).toBe(false);
  });

  it("returns true for bare nicknames (no ! or @)", () => {
    expect(isIrcMutableAllowEntry("alice")).toBe(true);
    expect(isIrcMutableAllowEntry("irc:bob")).toBe(true);
    expect(isIrcMutableAllowEntry("user:charlie")).toBe(true);
  });
});

describe("isZalouserMutableGroupEntry", () => {
  it("returns false for empty, whitespace, and wildcard inputs", () => {
    expect(isZalouserMutableGroupEntry("")).toBe(false);
    expect(isZalouserMutableGroupEntry("  ")).toBe(false);
    expect(isZalouserMutableGroupEntry("*")).toBe(false);
  });

  it("returns false for prefix-only entries", () => {
    expect(isZalouserMutableGroupEntry("zalouser:")).toBe(false);
    expect(isZalouserMutableGroupEntry("zlu:")).toBe(false);
    expect(isZalouserMutableGroupEntry("zalouser:group:")).toBe(false);
  });

  it("returns false for numeric group IDs", () => {
    expect(isZalouserMutableGroupEntry("123456789")).toBe(false);
    expect(isZalouserMutableGroupEntry("zalouser:123456789")).toBe(false);
    expect(isZalouserMutableGroupEntry("zlu:group:99887766")).toBe(false);
  });

  it("returns false for g- prefixed group identifiers", () => {
    expect(isZalouserMutableGroupEntry("g-abc123")).toBe(false);
    expect(isZalouserMutableGroupEntry("zalouser:g-abc123")).toBe(false);
    expect(isZalouserMutableGroupEntry("zlu:group:g-xyz789")).toBe(false);
  });

  it("returns true for mutable group names", () => {
    expect(isZalouserMutableGroupEntry("Ops Room")).toBe(true);
    expect(isZalouserMutableGroupEntry("zalouser:My Group")).toBe(true);
    expect(isZalouserMutableGroupEntry("zlu:group:Team Chat")).toBe(true);
  });

  it("returns true for non-numeric, non-g- prefixed strings", () => {
    expect(isZalouserMutableGroupEntry("abc123")).toBe(true);
    expect(isZalouserMutableGroupEntry("group-name")).toBe(true);
  });
});
