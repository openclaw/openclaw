import { describe, expect, it } from "vitest";
import { parseSlashCommand, SLASH_COMMANDS } from "./slash-commands.ts";

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

  it("parses fast commands", () => {
    expect(parseSlashCommand("/fast:on")).toMatchObject({
      command: { name: "fast" },
      args: "on",
    });
  });

  it("keeps /status on the agent path", () => {
    const status = SLASH_COMMANDS.find((entry) => entry.name === "status");
    expect(status?.executeLocal).not.toBe(true);
    expect(parseSlashCommand("/status")).toMatchObject({
      command: { name: "status" },
      args: "",
    });
  });
});
