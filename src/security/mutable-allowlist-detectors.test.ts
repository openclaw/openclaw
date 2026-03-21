import { describe, expect, it } from "vitest";
import {
  isDiscordMutableAllowEntry,
  isGoogleChatMutableAllowEntry,
  isIrcMutableAllowEntry,
  isMSTeamsMutableAllowEntry,
  isMattermostMutableAllowEntry,
  isSlackMutableAllowEntry,
  isZalouserMutableGroupEntry,
} from "./mutable-allowlist-detectors.js";

describe("isDiscordMutableAllowEntry", () => {
  it.each(["", " ", "*"])("returns false for %j", (input) => {
    expect(isDiscordMutableAllowEntry(input)).toBe(false);
  });

  it.each(["123456789012345678", "<@123456>", "<@!99999>"])(
    "returns false for numeric Discord ID %j",
    (input) => {
      expect(isDiscordMutableAllowEntry(input)).toBe(false);
    },
  );

  it.each(["discord:12345", "user:99999", "pk:12345"])(
    "returns false for prefixed ID %j",
    (input) => {
      expect(isDiscordMutableAllowEntry(input)).toBe(false);
    },
  );

  it.each(["discord:", "user:", "pk:"])("returns true for empty-after-prefix %j", (input) => {
    expect(isDiscordMutableAllowEntry(input)).toBe(true);
  });

  it.each(["SomeUsername", "name#1234", "display name with spaces"])(
    "returns true for mutable display name %j",
    (input) => {
      expect(isDiscordMutableAllowEntry(input)).toBe(true);
    },
  );
});

describe("isSlackMutableAllowEntry", () => {
  it.each(["", " ", "*"])("returns false for %j", (input) => {
    expect(isSlackMutableAllowEntry(input)).toBe(false);
  });

  it.each(["<@U12345678>", "<@W123456789>", "<@u12345678>"])(
    "returns false for Slack mention %j",
    (input) => {
      expect(isSlackMutableAllowEntry(input)).toBe(false);
    },
  );

  it.each(["U12345678", "W123456ABCD", "slack:U12345678", "user:W12345678"])(
    "returns false for Slack user ID %j",
    (input) => {
      expect(isSlackMutableAllowEntry(input)).toBe(false);
    },
  );

  it.each(["ABCDEFGH", "12345678"])("returns false for 8+ alphanumeric ID %j", (input) => {
    expect(isSlackMutableAllowEntry(input)).toBe(false);
  });

  it.each(["John Doe", "user@example.com", "@displayname"])(
    "returns true for mutable entry %j",
    (input) => {
      expect(isSlackMutableAllowEntry(input)).toBe(true);
    },
  );
});

describe("isGoogleChatMutableAllowEntry", () => {
  it.each(["", " ", "*"])("returns false for %j", (input) => {
    expect(isGoogleChatMutableAllowEntry(input)).toBe(false);
  });

  it.each(["googlechat:", "google-chat:", "gchat:"])(
    "returns false for empty-after-prefix %j",
    (input) => {
      expect(isGoogleChatMutableAllowEntry(input)).toBe(false);
    },
  );

  it.each(["googlechat:users/123456789", "gchat:123456789"])(
    "returns false for numeric Google Chat ID %j",
    (input) => {
      expect(isGoogleChatMutableAllowEntry(input)).toBe(false);
    },
  );

  it.each(["googlechat:user@example.com", "gchat:users/user@example.com", "user@example.com"])(
    "returns true for email-based entry %j",
    (input) => {
      expect(isGoogleChatMutableAllowEntry(input)).toBe(true);
    },
  );
});

describe("isMSTeamsMutableAllowEntry", () => {
  it.each(["", " ", "*"])("returns false for %j", (input) => {
    expect(isMSTeamsMutableAllowEntry(input)).toBe(false);
  });

  it.each(["msteams:abc123def456", "user:abc123def456", "abc123def456"])(
    "returns false for compact ID %j",
    (input) => {
      expect(isMSTeamsMutableAllowEntry(input)).toBe(false);
    },
  );

  it.each(["msteams:user@example.com", "John Doe", "user:John Doe"])(
    "returns true for mutable entry %j",
    (input) => {
      expect(isMSTeamsMutableAllowEntry(input)).toBe(true);
    },
  );
});

describe("isMattermostMutableAllowEntry", () => {
  it.each(["", " ", "*"])("returns false for %j", (input) => {
    expect(isMattermostMutableAllowEntry(input)).toBe(false);
  });

  it("returns false for 26-char Mattermost ID", () => {
    expect(isMattermostMutableAllowEntry("abcdefghijklmnopqrstuvwxyz")).toBe(false);
    expect(isMattermostMutableAllowEntry("mattermost:abcdefghijklmnopqrstuvwxyz")).toBe(false);
    expect(isMattermostMutableAllowEntry("@abcdefghijklmnopqrstuvwxyz")).toBe(false);
  });

  it.each(["johndoe", "mattermost:johndoe", "@johndoe", "Display Name"])(
    "returns true for mutable entry %j",
    (input) => {
      expect(isMattermostMutableAllowEntry(input)).toBe(true);
    },
  );
});

describe("isIrcMutableAllowEntry", () => {
  it.each(["", " ", "*"])("returns false for %j", (input) => {
    expect(isIrcMutableAllowEntry(input)).toBe(false);
  });

  it.each(["nick!user@host", "irc:nick!user@host", "user:nick!user@host"])(
    "returns false for hostmask entry %j",
    (input) => {
      expect(isIrcMutableAllowEntry(input)).toBe(false);
    },
  );

  it.each(["nick@host"])("returns false for entry with @ %j", (input) => {
    expect(isIrcMutableAllowEntry(input)).toBe(false);
  });

  it.each(["NickName", "irc:NickName", "user:NickName"])(
    "returns true for mutable nick-only entry %j",
    (input) => {
      expect(isIrcMutableAllowEntry(input)).toBe(true);
    },
  );
});

describe("isZalouserMutableGroupEntry", () => {
  it.each(["", " ", "*"])("returns false for %j", (input) => {
    expect(isZalouserMutableGroupEntry(input)).toBe(false);
  });

  it.each(["zalouser:", "zlu:", "zlu:group:"])(
    "returns false for empty-after-prefix %j",
    (input) => {
      expect(isZalouserMutableGroupEntry(input)).toBe(false);
    },
  );

  it.each(["123456789", "zalouser:123456789", "zlu:group:123456789"])(
    "returns false for numeric ID %j",
    (input) => {
      expect(isZalouserMutableGroupEntry(input)).toBe(false);
    },
  );

  it.each(["g-abc123", "zalouser:g-abc123", "zlu:group:g-abc123"])(
    "returns false for group reference %j",
    (input) => {
      expect(isZalouserMutableGroupEntry(input)).toBe(false);
    },
  );

  it.each(["DisplayName", "zalouser:DisplayName", "Group Name With Spaces"])(
    "returns true for mutable entry %j",
    (input) => {
      expect(isZalouserMutableGroupEntry(input)).toBe(true);
    },
  );
});
