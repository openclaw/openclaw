import { describe, expect, it } from "vitest";
import {
  ANNOUNCE_SKIP_TOKEN,
  REPLY_SKIP_TOKEN,
  isAnnounceSkip,
  isReplySkip,
} from "./sessions-send-tokens.js";

describe("isAnnounceSkip", () => {
  it("returns true for the canonical lone token", () => {
    expect(isAnnounceSkip(ANNOUNCE_SKIP_TOKEN)).toBe(true);
  });

  it("returns true for the lone token with surrounding whitespace", () => {
    expect(isAnnounceSkip(`   ${ANNOUNCE_SKIP_TOKEN}   `)).toBe(true);
    expect(isAnnounceSkip(`\n\n${ANNOUNCE_SKIP_TOKEN}\n`)).toBe(true);
  });

  it("returns true when the token is the standalone final line after a summary (regression for #74071)", () => {
    const summary = `## DM Summary\n\nThis is the summary block the agent produced.\n\nMultiple paragraphs are common.\n\n${ANNOUNCE_SKIP_TOKEN}`;
    expect(isAnnounceSkip(summary)).toBe(true);
  });

  it("returns true when trailing whitespace follows the final-line token (regression for #74071)", () => {
    const summary = `Some output line.\n${ANNOUNCE_SKIP_TOKEN}\n  \n`;
    expect(isAnnounceSkip(summary)).toBe(true);
  });

  it("returns false when the token appears mid-line embedded in other text", () => {
    expect(isAnnounceSkip(`${ANNOUNCE_SKIP_TOKEN} but please send anyway`)).toBe(false);
    expect(isAnnounceSkip(`prefix ${ANNOUNCE_SKIP_TOKEN}`)).toBe(false);
  });

  it("returns false when the token is on the same line as content (no preceding newline)", () => {
    expect(isAnnounceSkip(`Reply text ${ANNOUNCE_SKIP_TOKEN}`)).toBe(false);
  });

  it("returns false for unrelated text", () => {
    expect(isAnnounceSkip("Hello world")).toBe(false);
    expect(isAnnounceSkip("REPLY_SKIP")).toBe(false);
  });

  it("returns false for undefined / empty input", () => {
    expect(isAnnounceSkip(undefined)).toBe(false);
    expect(isAnnounceSkip("")).toBe(false);
    expect(isAnnounceSkip("   ")).toBe(false);
  });
});

describe("isReplySkip (semantics intentionally unchanged by #74071)", () => {
  it("returns true only for the canonical lone token", () => {
    expect(isReplySkip(REPLY_SKIP_TOKEN)).toBe(true);
    expect(isReplySkip(`  ${REPLY_SKIP_TOKEN}  `)).toBe(true);
  });

  it("returns false for multi-line REPLY_SKIP variants (kept strict)", () => {
    expect(isReplySkip(`Some reply\n${REPLY_SKIP_TOKEN}`)).toBe(false);
  });
});
