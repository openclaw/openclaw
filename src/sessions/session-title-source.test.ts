import { describe, expect, it } from "vitest";
import type { SkillCommandSpec } from "../skills/types.js";
import { resolveSessionTitleSource } from "./session-title-source.js";

const skillCommands: SkillCommandSpec[] = [
  { name: "code-review", skillName: "code-review", description: "Review code" },
];

describe("resolveSessionTitleSource", () => {
  it.each([
    ["/tmp/notes.md summarise this file", "tmp/notes.md summarise this file"],
    ["/Users/me/notes/handover.md", "Users/me/notes/handover.md"],
    ["/explain how DNS resolution works", "explain how DNS resolution works"],
  ])("keeps unregistered slash text %j eligible for titles", (message, expected) => {
    expect(resolveSessionTitleSource(message)).toBe(expected);
  });

  it.each([["/new"], ["/reset"], ["/NEW"], ["/"], ["//"]])(
    "keeps control or empty slash text %j titleless",
    (message) => {
      expect(resolveSessionTitleSource(message)).toBeNull();
    },
  );

  it("uses registered skill arguments as the title source", () => {
    expect(
      resolveSessionTitleSource("/code-review https://example.com/pull/123", skillCommands),
    ).toBe("https://example.com/pull/123");
  });

  it("keeps a bare registered skill command titleless", () => {
    expect(resolveSessionTitleSource("/code-review", skillCommands)).toBeNull();
  });

  it("passes ordinary text through unchanged", () => {
    expect(resolveSessionTitleSource("explain how DNS resolution works")).toBe(
      "explain how DNS resolution works",
    );
  });
});
