import { describe, expect, it } from "vitest";
import type { SkillCommandSpec } from "../skills/types.js";
import { resolveSessionTitleSource } from "./session-title-source.js";

function makeCommand(name: string): SkillCommandSpec {
  return {
    name,
    skillName: name,
    description: "Demo",
    rawName: name,
  } as SkillCommandSpec;
}

describe("resolveSessionTitleSource", () => {
  it("passes through ordinary task text", () => {
    expect(resolveSessionTitleSource("Summarise the notes")).toBe("Summarise the notes");
  });

  it("titles pasted absolute paths that start with /", () => {
    expect(resolveSessionTitleSource("/tmp/notes.md summarise this file")).toBe(
      "/tmp/notes.md summarise this file",
    );
    expect(resolveSessionTitleSource("//share/docs/plan.md")).toBe("//share/docs/plan.md");
  });

  it("skips control commands and unregistered slash commands", () => {
    expect(resolveSessionTitleSource("/status")).toBeNull();
    expect(resolveSessionTitleSource("/model choose-a-model")).toBeNull();
    expect(resolveSessionTitleSource("/unknown task")).toBeNull();
  });

  it("uses skill args when skill metadata matches", () => {
    const skillCommands = [makeCommand("topic")];
    expect(resolveSessionTitleSource("/topic", skillCommands)).toBeNull();
    expect(resolveSessionTitleSource("/topic Plan the release", skillCommands)).toBe(
      "Plan the release",
    );
  });
});
