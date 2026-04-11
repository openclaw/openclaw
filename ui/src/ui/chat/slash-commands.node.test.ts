import { describe, expect, it } from "vitest";
import {
  getSlashCommandCompletions,
  parseSlashCommand,
  resolveSlashCommands,
  SLASH_COMMANDS,
} from "./slash-commands.ts";

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

  it("adds runtime skill commands while preserving local UI commands", () => {
    const commands = resolveSlashCommands([
      {
        name: "help",
        textAliases: ["/help"],
        description: "Show available commands.",
        acceptsArgs: false,
        source: "native",
        scope: "both",
        category: "status",
      },
      {
        name: "office_hours",
        textAliases: ["/office_hours", "/office-hours"],
        description: "Run office hours workflow.",
        acceptsArgs: true,
        source: "skill",
        scope: "both",
        category: "tools",
      },
    ]);

    expect(commands.find((entry) => entry.name === "office_hours")).toMatchObject({
      key: "office_hours",
      name: "office_hours",
      aliases: ["office-hours"],
      executeLocal: false,
    });
    expect(commands.find((entry) => entry.name === "clear")).toMatchObject({
      key: "clear",
      executeLocal: true,
    });
  });

  it("parses runtime skill commands from the dynamic catalog", () => {
    const commands = resolveSlashCommands([
      {
        name: "office_hours",
        textAliases: ["/office_hours", "/office-hours"],
        description: "Run office hours workflow.",
        acceptsArgs: true,
        source: "skill",
        scope: "both",
        category: "tools",
      },
    ]);

    expect(parseSlashCommand("/office_hours today", commands)).toMatchObject({
      command: { key: "office_hours", name: "office_hours" },
      args: "today",
    });
    expect(parseSlashCommand("/office-hours tomorrow", commands)).toMatchObject({
      command: { key: "office_hours", name: "office_hours" },
      args: "tomorrow",
    });
  });

  it("uses runtime skill commands in autocomplete and falls back to static commands when missing", () => {
    const commands = resolveSlashCommands([
      {
        name: "office_hours",
        textAliases: ["/office_hours", "/office-hours"],
        description: "Run office hours workflow.",
        acceptsArgs: true,
        source: "skill",
        scope: "both",
        category: "tools",
      },
    ]);

    expect(getSlashCommandCompletions("office", commands).map((entry) => entry.name)).toContain(
      "office_hours",
    );
    expect(getSlashCommandCompletions("help", null).map((entry) => entry.name)).toContain("help");
  });

  it("keeps UI description and args overrides for dynamic entries", () => {
    const commands = resolveSlashCommands([
      {
        name: "steer",
        textAliases: ["/steer", "/tell"],
        description: "Server-side steer text",
        acceptsArgs: true,
        source: "native",
        scope: "both",
        category: "management",
        args: [
          {
            name: "message",
            description: "Message",
            type: "string",
            required: true,
          },
        ],
      },
    ]);

    expect(commands.find((entry) => entry.name === "steer")).toMatchObject({
      description: "Inject a message into the active run",
      args: "[id] <message>",
      aliases: expect.arrayContaining(["tell"]),
    });
  });
});
