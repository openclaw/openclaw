import { expectDefined } from "@openclaw/normalization-core";
// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import type { CommandEntry } from "../../../../packages/gateway-protocol/src/index.js";
import { expectObjectFields } from "../../../../src/test-utils/mock-call-assertions.js";
import {
  buildFallbackSlashCommands,
  buildSlashCommandsFromEntries,
  findInlineSlashCompletion,
  getRemoteCommandEntries,
  getSlashCommandDescription,
  getSkillCommandCompletions,
  getSlashCommandCompletions,
  isModelIndependentChatCommand,
  parseSlashCommand,
  replaceSlashCommands,
  SLASH_COMMANDS,
  type SlashCommandDef,
} from "./commands.ts";

afterEach(() => {
  replaceSlashCommands(buildFallbackSlashCommands());
});

describe("model-independent commands", () => {
  it.each([
    "/unknown",
    "Please /models",
    "/model example/model explain this",
    "/send on explain this",
    "/whoami explain this",
  ])("requires model access for %s", (command) =>
    expect(isModelIndependentChatCommand(command)).toBe(false),
  );
});

describe("findInlineSlashCompletion", () => {
  it.each([
    ["/thi", undefined, { query: "thi", start: 0, end: 4, inline: false }],
    ["Please use /wea", undefined, { query: "wea", start: 11, end: 15, inline: true }],
    ["Use /weather tomorrow", 8, { query: "wea", start: 4, end: 12, inline: true }],
    ["/thinking please", 4, { query: "thi", start: 0, end: 9, inline: true }],
    [
      "Please use /weather:",
      undefined,
      { query: "weather", start: 11, end: 20, inline: true, skillOnly: true },
    ],
    ["https://example.com/wea", undefined, null],
    ["Open tmp/wea", undefined, null],
    ["Use //wea", undefined, null],
  ])("finds only slash tokens at the caret in %j", (text, caret, expected) => {
    expect(findInlineSlashCompletion(text, caret)).toEqual(expected);
  });

  it("offers every non-skill command inline and can hide them when no command owner exists", () => {
    applyRemoteEntries([
      remoteCommand("weather", {
        source: "skill",
        skillModelVisible: true,
        scope: "text",
      }),
    ]);
    expect(completionNames("weather", { inlineOnly: true })).toEqual(["weather"]);
    expect(completionNames("reset", { inlineOnly: true })).toEqual(["reset"]);
    expect(completionNames("elevated", { inlineOnly: true })).toEqual(["elevated"]);
    expect(completionNames("exec", { inlineOnly: true })).toContain("exec");
    expect(completionNames("think", { inlineOnly: true })).toContain("think");
    expect(
      getSlashCommandCompletions("reset", {
        inlineOnly: true,
        allowImmediateInlineCommands: false,
      }),
    ).toEqual([]);
    expect(
      completionNames("weather", {
        inlineOnly: true,
        allowImmediateInlineCommands: false,
      }),
    ).toEqual(["weather"]);
  });
});

function expectCommand(name: string, expected: Record<string, unknown>) {
  expectObjectFields(requireCommandByName(name), expected);
}

function requireCommandByName(name: string): SlashCommandDef {
  return expectDefined(
    SLASH_COMMANDS.find((entry) => entry.name === name),
    `slash command ${name}`,
  );
}

function applyRemoteEntries(entries: Parameters<typeof buildSlashCommandsFromEntries>[0]) {
  replaceSlashCommands(buildSlashCommandsFromEntries(entries));
}

function applyCommandsListResult(result: { commands?: unknown }) {
  applyRemoteEntries(getRemoteCommandEntries(result));
}

function expectParsedSlash(input: string, commandFields: Record<string, unknown>, args: string) {
  const parsed = expectDefined(parseSlashCommand(input), `parsed ${input}`);
  expectObjectFields(parsed.command, commandFields);
  expect(parsed.args).toBe(args);
}

function completionNames(
  filter: string,
  options?: Parameters<typeof getSlashCommandCompletions>[1],
): string[] {
  return getSlashCommandCompletions(filter, options).map((command) => command.name);
}

function remoteCommand(name: string, overrides: Partial<CommandEntry> = {}): CommandEntry {
  return {
    name,
    textAliases: [`/${name}`],
    description: `${name} command.`,
    source: "plugin",
    scope: "both",
    acceptsArgs: true,
    ...overrides,
  };
}

function slashCommand(
  name: string,
  options: Partial<Omit<SlashCommandDef, "key" | "name">> = {},
): SlashCommandDef {
  return { key: name, name, description: `${name} command.`, ...options };
}

describe("getSlashCommandCompletions", () => {
  it("ranks name and alias substrings above description-only matches", () => {
    replaceSlashCommands([
      slashCommand("helper", {
        description: "Repair a device.",
        tier: "essential",
        category: "session",
      }),
      slashCommand("connect", { aliases: ["repairing"], tier: "standard", category: "tools" }),
      slashCommand("repair", { tier: "power", category: "agents" }),
      slashCommand("pairing", { tier: "power", category: "agents" }),
    ]);

    expect(completionNames("pair")).toEqual(["pairing", "connect", "repair", "helper"]);
  });

  it("keeps empty-query tier and category ordering unchanged", () => {
    replaceSlashCommands([
      slashCommand("standard-agent", { tier: "standard", category: "agents" }),
      slashCommand("essential-tools", { tier: "essential", category: "tools" }),
      slashCommand("power-session", { tier: "power", category: "session" }),
      slashCommand("essential-session", { tier: "essential", category: "session" }),
      slashCommand("standard-session", { tier: "standard", category: "session" }),
    ]);

    expect(completionNames("")).toEqual([
      "essential-session",
      "essential-tools",
      "standard-session",
      "standard-agent",
    ]);
    expect(completionNames("", { showAll: true })).toEqual([
      "essential-session",
      "essential-tools",
      "standard-session",
      "standard-agent",
      "power-session",
    ]);
  });
});

describe("parseSlashCommand", () => {
  it("parses fast commands", () => {
    expectParsedSlash("/fast:on", { name: "fast" }, "on");
  });

  it("builds runtime commands from native, plugin, and direct skill entries", () => {
    applyRemoteEntries([
      remoteCommand("inspect-session", {
        textAliases: ["/inspect-session", "/inspect_session"],
        source: "native",
        acceptsArgs: false,
        category: "tools",
      }),
      remoteCommand("dreaming"),
      remoteCommand("draft", {
        source: "skill",
        skillModelVisible: true,
      }),
    ]);

    expectCommand("inspect-session", {
      aliases: ["inspect_session"],
      category: "tools",
      executeLocal: false,
    });
    expectCommand("dreaming", { key: "dreaming", executeLocal: false });
    expectCommand("draft", {
      key: "draft",
      executeLocal: false,
      source: "skill",
      skillModelVisible: true,
    });
    expectParsedSlash("/inspect_session", { name: "inspect-session" }, "");
    expect(getSkillCommandCompletions("dra").map((command) => command.name)).toEqual(["draft"]);
  });

  it("matches skill queries against both display titles and command tokens", () => {
    applyRemoteEntries([
      remoteCommand("release_notes", {
        skillDisplayName: "Release Notes",
        source: "skill",
        skillModelVisible: true,
      }),
    ]);

    expect(getSkillCommandCompletions("notes")).toMatchObject([
      { name: "release_notes", skillDisplayName: "Release Notes" },
    ]);
    expect(getSkillCommandCompletions("release_n")).toMatchObject([
      { name: "release_notes", skillDisplayName: "Release Notes" },
    ]);
  });

  it.each([false, undefined])(
    "keeps skills with visibility %j in slash commands but out of $ completions",
    (skillModelVisible) => {
      applyRemoteEntries([remoteCommand("hidden_skill", { source: "skill", skillModelVisible })]);
      expectParsedSlash("/hidden_skill", { name: "hidden_skill" }, "");
      expect(getSkillCommandCompletions("hidden")).toEqual([]);
    },
  );

  it("does not let remote commands collide with reserved local commands", () => {
    applyRemoteEntries([remoteCommand("redirect")]);

    expectCommand("redirect", {
      key: "redirect",
      executeLocal: true,
      description: "Abort and restart with a new message",
    });
  });

  it("keeps remote descriptions when a command name matches an object prototype property", () => {
    applyRemoteEntries([
      remoteCommand("constructor", {
        description: "Construct a sample project.",
        acceptsArgs: false,
      }),
    ]);

    const command = expectDefined(getSlashCommandCompletions("constructor")[0], "completion");
    expect(command.name).toBe("constructor");
    expect(getSlashCommandDescription(command)).toBe("Construct a sample project.");
  });

  it("drops remote commands with unsafe identifiers before they reach the palette/parser", () => {
    applyRemoteEntries([
      remoteCommand("draft now", {
        textAliases: ["/draft now", "/safe-name"],
        source: "skill",
      }),
      remoteCommand("bad:alias", { acceptsArgs: false }),
    ]);

    expectCommand("safe-name", { name: "safe-name" });
    expect(SLASH_COMMANDS.find((entry) => entry.name === "draft now")).toBeUndefined();
    expect(SLASH_COMMANDS.find((entry) => entry.name === "bad:alias")).toBeUndefined();
    expectParsedSlash("/safe-name", { name: "safe-name" }, "");
  });

  it("caps remote command payload size and long metadata before it reaches UI state", () => {
    const longName = "x".repeat(260);
    const longDescription = `${"d".repeat(1_999)}🚀tail`;
    const boundaryArgName = `${"n".repeat(199)}🚀tail`;
    const oversizedCommand = remoteCommand("plugin-0", {
      textAliases: Array.from({ length: 25 }, (_, aliasIndex) => `/plugin-0-${aliasIndex}`),
      description: longDescription,
      args: Array.from({ length: 25 }, (_, argIndex) => ({
        name: argIndex === 0 ? boundaryArgName : `${longName}-${argIndex}`,
        description: longDescription,
        type: "string" as const,
        choices: Array.from({ length: 55 }, (_Local, choiceIndex) => ({
          value: `${longName}-${choiceIndex}`,
          label: `${longName}-${choiceIndex}`,
        })),
      })),
    });
    applyRemoteEntries([
      oversizedCommand,
      ...Array.from({ length: 519 }, (_, index) =>
        remoteCommand(`plugin-${index + 1}`, {
          acceptsArgs: false,
        }),
      ),
    ]);

    const remoteCommands = SLASH_COMMANDS.filter((entry) => entry.name.startsWith("plugin-"));
    expect(remoteCommands).toHaveLength(500);
    const first = expectDefined(remoteCommands[0], "first capped remote command");
    expect(first.aliases).toHaveLength(19);
    expect(first.description).toBe("d".repeat(1_999));
    expect(first.args?.split(" ")).toHaveLength(20);
    expect(first.args?.split(" ")[0]).toBe("[" + "n".repeat(199) + "]");
    expect(first.argOptions).toHaveLength(50);
  });

  it("preserves only known closed plugin client presentation metadata", () => {
    applyRemoteEntries([
      remoteCommand("pair", {
        clientPresentation: {
          when: "no-arguments",
          action: { kind: "device-pairing" },
        },
      }),
    ]);

    expect(requireCommandByName("pair").clientPresentation).toEqual({
      when: "no-arguments",
      action: { kind: "device-pairing" },
    });
  });

  it.each([
    { when: "always", action: { kind: "device-pairing" } },
    { when: "no-arguments", action: { kind: "open-route" } },
    { when: "no-arguments", action: { kind: "device-pairing", callback: "run" } },
    {
      when: "no-arguments",
      action: { kind: "device-pairing" },
      route: "/settings/devices",
    },
  ])("drops malformed client presentation metadata %#", (clientPresentation) => {
    applyCommandsListResult({
      commands: [{ ...remoteCommand("pair"), clientPresentation }],
    });

    expect(requireCommandByName("pair").clientPresentation).toBeUndefined();
  });

  it("falls back safely when command payload shapes are malformed", () => {
    applyCommandsListResult({ commands: { bad: "shape" } });
    expect(SLASH_COMMANDS.find((entry) => entry.name === "pair")).toBeUndefined();
    expectCommand("help", {
      key: "help",
      name: "help",
      executeLocal: true,
    });

    applyCommandsListResult({
      commands: [
        {
          name: "valid",
          textAliases: ["/valid"],
          description: 42,
          args: { nope: true },
        },
        {
          ...remoteCommand("pair"),
          args: [
            {
              name: "mode",
              required: "yes",
              choices: { broken: true },
            },
          ],
        },
      ],
    });
    expectCommand("valid", { name: "valid", description: "" });
    expectCommand("pair", { name: "pair" });
  });
});
