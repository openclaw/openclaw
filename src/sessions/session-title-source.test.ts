import { describe, expect, it } from "vitest";
import { resolveSessionTitleSource } from "./session-title-source.js";

describe("resolveSessionTitleSource", () => {
  it.each([
    ["/new", null],
    ["/reset", null],
    ["/explain how DNS resolution works", "/explain how DNS resolution works"],
    ["/tmp/notes.md summarise this file", "/tmp/notes.md summarise this file"],
    [
      "/Users/me/notes/handover.md Have a read through this.",
      "/Users/me/notes/handover.md Have a read through this.",
    ],
    ["explain how DNS resolution works", "explain how DNS resolution works"],
    [
      "please read /tmp/notes.md and summarise it",
      "please read /tmp/notes.md and summarise it",
    ],
  ])("maps %j to %j", (input, expected) => {
    expect(resolveSessionTitleSource(input)).toBe(expected);
  });

  it("uses skill-command args when a registered skill owns the slash token", () => {
    expect(
      resolveSessionTitleSource("/code-review https://github.com/openclaw/openclaw/pull/1", [
        { name: "code-review", skillName: "code-review", description: "review", promptTemplate: "Review $ARGUMENTS" },
      ]),
    ).toBe("https://github.com/openclaw/openclaw/pull/1");
  });

  it("skips bare skill commands that carry no args", () => {
    expect(
      resolveSessionTitleSource("/code-review", [
        { name: "code-review", skillName: "code-review", description: "review", promptTemplate: "Review $ARGUMENTS" },
      ]),
    ).toBeNull();
  });
});