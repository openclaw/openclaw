import { describe, expect, it } from "vitest";
import { parseSlashCommand } from "./slash-commands.ts";

describe("parseSlashCommand", () => {
  it("parses commands with an optional colon separator", () => {
    expect(parseSlashCommand("/think: high")).toMatchObject({
      command: { name: "think" },
      args: "high",
    });
    expect(parseSlashCommand("/think:high")).toMatchObject({
      command: { name: "think" },
      args: "high",
    });
    expect(parseSlashCommand("/help:")).toMatchObject({
      command: { name: "help" },
      args: "",
    });
  });

  it("still parses space-delimited commands", () => {
    expect(parseSlashCommand("/verbose full")).toMatchObject({
      command: { name: "verbose" },
      args: "full",
    });
  });
});
