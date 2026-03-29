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

  it("includes shared /tools with shared arg hints", () => {
    const tools = SLASH_COMMANDS.find((entry) => entry.name === "tools");
    expect(tools).toMatchObject({
      key: "tools",
      description: "List available runtime tools.",
      argOptions: ["compact", "verbose"],
      executeLocal: false,
    });
    expect(parseSlashCommand("/tools verbose")).toMatchObject({
      command: { name: "tools" },
      args: "verbose",
    });
  });

  it("parses slash aliases through the shared registry", () => {
    const exportCommand = SLASH_COMMANDS.find((entry) => entry.key === "export-session");
    expect(exportCommand).toMatchObject({
      name: "export-session",
      aliases: ["export"],
      executeLocal: true,
    });
    expect(parseSlashCommand("/export")).toMatchObject({
      command: { key: "export-session" },
      args: "",
    });
    expect(parseSlashCommand("/export-session")).toMatchObject({
      command: { key: "export-session" },
      args: "",
    });
  });

  it("keeps canonical long-form slash names as the primary menu command", () => {
    expect(SLASH_COMMANDS.find((entry) => entry.key === "verbose")).toMatchObject({
      name: "verbose",
      aliases: ["v"],
    });
    expect(SLASH_COMMANDS.find((entry) => entry.key === "think")).toMatchObject({
      name: "think",
      aliases: expect.arrayContaining(["thinking", "t"]),
    });
  });

  it("keeps a single local /steer entry with the control-ui metadata", () => {
    const steerEntries = SLASH_COMMANDS.filter((entry) => entry.name === "steer");
    expect(steerEntries).toHaveLength(1);
    expect(steerEntries[0]).toMatchObject({
      key: "steer",
      description: "Inject a message into the active run",
      args: "[id] <message>",
      aliases: expect.arrayContaining(["tell"]),
      executeLocal: true,
    });
  });

  it("keeps focus as a local slash command", () => {
    expect(parseSlashCommand("/focus")).toMatchObject({
      command: { key: "focus", executeLocal: true },
      args: "",
    });
  });
});
