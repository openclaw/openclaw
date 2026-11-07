import { describe, expect, it } from "vitest";
import { isControlCommandMessage } from "../auto-reply/command-detection.js";
import type { SkillCommandSpec } from "../skills/types.js";
import { resolveSessionTitleSource } from "./session-title-source.js";

const skillCommands: SkillCommandSpec[] = [
  { name: "code-review", skillName: "code-review", description: "Review code" },
];

describe("resolveSessionTitleSource with the skill registry", () => {
  it.each([
    ["/tmp/notes.md summarise this file", "tmp/notes.md summarise this file"],
    ["/Users/me/notes/handover.md", "Users/me/notes/handover.md"],
    ["/explain how DNS resolution works", "explain how DNS resolution works"],
  ])("keeps unregistered slash text %j eligible for titles", (message, expected) => {
    expect(
      resolveSessionTitleSource(message, [], { isControlCommand: isControlCommandMessage }),
    ).toBe(expected);
  });

  it.each([
    ["/new"],
    ["/reset"],
    ["/NEW"],
    ["/status"],
    ["/model gpt-5"],
    ["/steer fix it"],
    ["/"],
    ["//"],
  ])("keeps control or empty slash text %j titleless", (message) => {
    expect(
      resolveSessionTitleSource(message, [], { isControlCommand: isControlCommandMessage }),
    ).toBeNull();
  });

  it("uses registered skill arguments as the title source", () => {
    expect(
      resolveSessionTitleSource("/code-review https://example.com/pull/123", skillCommands, {
        isControlCommand: isControlCommandMessage,
      }),
    ).toBe("https://example.com/pull/123");
  });

  it("keeps a bare registered skill command titleless", () => {
    expect(
      resolveSessionTitleSource("/code-review", skillCommands, {
        isControlCommand: isControlCommandMessage,
      }),
    ).toBeNull();
  });
});

describe("resolveSessionTitleSource without the skill registry", () => {
  it.each([
    ["/tmp/notes.md summarise this file"],
    ["/explain how DNS resolution works"],
    ["/code-review https://example.com/pull/123"],
  ])("preserves the legacy titleless contract for %j", (message) => {
    expect(resolveSessionTitleSource(message)).toBeNull();
  });
});
