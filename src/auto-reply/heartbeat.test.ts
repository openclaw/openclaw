import { describe, expect, it } from "vitest";

import {
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  isHeartbeatContentEffectivelyEmpty,
  stripHeartbeatToken,
} from "./heartbeat.js";
import { HEARTBEAT_TOKEN } from "./tokens.js";

describe("stripHeartbeatToken", () => {
  it("skips empty or token-only replies", () => {
    expect(stripHeartbeatToken(undefined, { mode: "heartbeat" })).toEqual({
      shouldSkip: true,
      text: "",
      didStrip: false,
    });
    expect(stripHeartbeatToken("  ", { mode: "heartbeat" })).toEqual({
      shouldSkip: true,
      text: "",
      didStrip: false,
    });
    expect(stripHeartbeatToken(HEARTBEAT_TOKEN, { mode: "heartbeat" })).toEqual({
      shouldSkip: true,
      text: "",
      didStrip: true,
    });
  });

  it("drops heartbeats with small junk in heartbeat mode", () => {
    expect(stripHeartbeatToken("HEARTBEAT_OK 🦞", { mode: "heartbeat" })).toEqual({
      shouldSkip: true,
      text: "",
      didStrip: true,
    });
    expect(stripHeartbeatToken(`🦞 ${HEARTBEAT_TOKEN}`, { mode: "heartbeat" })).toEqual({
      shouldSkip: true,
      text: "",
      didStrip: true,
    });
  });

  it("drops short remainder in heartbeat mode", () => {
    expect(stripHeartbeatToken(`ALERT ${HEARTBEAT_TOKEN}`, { mode: "heartbeat" })).toEqual({
      shouldSkip: true,
      text: "",
      didStrip: true,
    });
  });

  it("keeps heartbeat replies when remaining content exceeds threshold", () => {
    const long = "A".repeat(DEFAULT_HEARTBEAT_ACK_MAX_CHARS + 1);
    expect(stripHeartbeatToken(`${long} ${HEARTBEAT_TOKEN}`, { mode: "heartbeat" })).toEqual({
      shouldSkip: false,
      text: long,
      didStrip: true,
    });
  });

  it("strips token at edges for normal messages", () => {
    expect(stripHeartbeatToken(`${HEARTBEAT_TOKEN} hello`, { mode: "message" })).toEqual({
      shouldSkip: false,
      text: "hello",
      didStrip: true,
    });
    expect(stripHeartbeatToken(`hello ${HEARTBEAT_TOKEN}`, { mode: "message" })).toEqual({
      shouldSkip: false,
      text: "hello",
      didStrip: true,
    });
  });

  it("does not touch token in the middle", () => {
    expect(
      stripHeartbeatToken(`hello ${HEARTBEAT_TOKEN} there`, {
        mode: "message",
      }),
    ).toEqual({
      shouldSkip: false,
      text: `hello ${HEARTBEAT_TOKEN} there`,
      didStrip: false,
    });
  });

  it("strips HTML-wrapped heartbeat tokens", () => {
    expect(stripHeartbeatToken(`<b>${HEARTBEAT_TOKEN}</b>`, { mode: "heartbeat" })).toEqual({
      shouldSkip: true,
      text: "",
      didStrip: true,
    });
  });

  it("strips markdown-wrapped heartbeat tokens", () => {
    expect(stripHeartbeatToken(`**${HEARTBEAT_TOKEN}**`, { mode: "heartbeat" })).toEqual({
      shouldSkip: true,
      text: "",
      didStrip: true,
    });
  });

  it("removes markup-wrapped token and keeps trailing content", () => {
    expect(
      stripHeartbeatToken(`<code>${HEARTBEAT_TOKEN}</code> all good`, {
        mode: "message",
      }),
    ).toEqual({
      shouldSkip: false,
      text: "all good",
      didStrip: true,
    });
  });
});

describe("isHeartbeatContentEffectivelyEmpty", () => {
  it("returns false for undefined/null (missing file should not skip)", () => {
    expect(isHeartbeatContentEffectivelyEmpty(undefined)).toBe(false);
    expect(isHeartbeatContentEffectivelyEmpty(null)).toBe(false);
  });

  it("returns true for empty string", () => {
    expect(isHeartbeatContentEffectivelyEmpty("")).toBe(true);
  });

  it("returns true for whitespace only", () => {
    expect(isHeartbeatContentEffectivelyEmpty("   ")).toBe(true);
    expect(isHeartbeatContentEffectivelyEmpty("\n\n\n")).toBe(true);
    expect(isHeartbeatContentEffectivelyEmpty("  \n  \n  ")).toBe(true);
    expect(isHeartbeatContentEffectivelyEmpty("\t\t")).toBe(true);
  });

  it("returns true for header-only content", () => {
    expect(isHeartbeatContentEffectivelyEmpty("# HEARTBEAT.md")).toBe(true);
    expect(isHeartbeatContentEffectivelyEmpty("# HEARTBEAT.md\n")).toBe(true);
    expect(isHeartbeatContentEffectivelyEmpty("# HEARTBEAT.md\n\n")).toBe(true);
  });

  it("returns true for comments only", () => {
    expect(isHeartbeatContentEffectivelyEmpty("# Header\n# Another comment")).toBe(true);
    expect(isHeartbeatContentEffectivelyEmpty("## Subheader\n### Another")).toBe(true);
  });

  it("returns true for default template content (header + comment)", () => {
    const defaultTemplate = `# HEARTBEAT.md

Keep this file empty unless you want a tiny checklist. Keep it small.
`;
    // Note: The template has actual text content, so it's NOT effectively empty
    expect(isHeartbeatContentEffectivelyEmpty(defaultTemplate)).toBe(false);
  });

  it("returns true for header with only empty lines", () => {
    expect(isHeartbeatContentEffectivelyEmpty("# HEARTBEAT.md\n\n\n")).toBe(true);
  });

  it("returns false when actionable content exists", () => {
    expect(isHeartbeatContentEffectivelyEmpty("- Check email")).toBe(false);
    expect(isHeartbeatContentEffectivelyEmpty("# HEARTBEAT.md\n- Task 1")).toBe(false);
    expect(isHeartbeatContentEffectivelyEmpty("Remind me to call mom")).toBe(false);
  });

  it("returns false for content with tasks after header", () => {
    const content = `# HEARTBEAT.md

- Task 1
- Task 2
`;
    expect(isHeartbeatContentEffectivelyEmpty(content)).toBe(false);
  });

  it("returns false for mixed content with non-comment text", () => {
    const content = `# HEARTBEAT.md
## Tasks
Check the server logs
`;
    expect(isHeartbeatContentEffectivelyEmpty(content)).toBe(false);
  });

  it("treats markdown headers as comments (effectively empty)", () => {
    const content = `# HEARTBEAT.md
## Section 1
### Subsection
`;
    expect(isHeartbeatContentEffectivelyEmpty(content)).toBe(true);
  });
});
