import { expectDefined } from "@openclaw/normalization-core";
// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import type { CommandEntry } from "../../../../packages/gateway-protocol/src/index.js";
import { expectObjectFields } from "../../../../src/test-utils/mock-call-assertions.js";
import {
  buildFallbackSlashCommands,
  buildSlashCommandsFromEntries,
  findInlineSlashCompletion,
  getSlashCommandDescription,
  getSkillCommandCompletions,
  getSlashCommandCompletions,
  isModelIndependentChatCommand,
  parseSlashCommand,
  replaceSlashCommands,
  SLASH_COMMANDS,
  type SlashCommandDef,
} from "./commands.ts";

afterEach(() => replaceSlashCommands(buildFallbackSlashCommands()));

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
    applyRemoteEntries(
      remoteCommand("weather", { source: "skill", skillModelVisible: true, scope: "text" }),
    );
    expect(completionNames("weather", { inlineOnly: true })).toEqual(["weather"]);
    expect(completionNames("reset", { inlineOnly: true })).toEqual(["reset"]);
    const noOwner = { inlineOnly: true, allowImmediateInlineCommands: false };
    expect(completionNames("reset", noOwner)).toEqual([]);
    expect(completionNames("weather", noOwner)).toEqual(["weather"]);
  });
});

function expectCommand(name: string, expected: Record<string, unknown>) {
  expectObjectFields(
    SLASH_COMMANDS.find((entry) => entry.name === name),
    expected,
  );
}

function applyRemoteEntries(...entries: Parameters<typeof buildSlashCommandsFromEntries>[0]) {
  replaceSlashCommands(buildSlashCommandsFromEntries(entries));
}

function expectParsedSlash(input: string, commandFields: Record<string, unknown>, args: string) {
  expect(parseSlashCommand(input)).toMatchObject({ command: commandFields, args });
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
      "power-session",
    ]);
  });
});

describe("parseSlashCommand", () => {
  it("parses fast commands", () => {
    expectParsedSlash("/fast:on", { name: "fast" }, "on");
  });

  it("builds runtime commands from native, plugin, and direct skill entries", () => {
    applyRemoteEntries(
      remoteCommand("inspect-session", {
        textAliases: ["/inspect-session", "/inspect_session"],
        source: "native",
      }),
      remoteCommand("dreaming"),
      remoteCommand("draft", {
        source: "skill",
        skillModelVisible: true,
      }),
    );

    expectCommand("inspect-session", {
      aliases: ["inspect_session"],
      executeLocal: false,
    });
    expectParsedSlash("/dreaming", { name: "dreaming", executeLocal: false }, "");
    expectParsedSlash("/inspect_session", { name: "inspect-session" }, "");
    expect(getSkillCommandCompletions("dra").map((command) => command.name)).toEqual(["draft"]);
  });

  it("matches skill queries against both display titles and command tokens", () => {
    applyRemoteEntries(
      remoteCommand("release_notes", {
        skillDisplayName: "Mu\u0308nchen Notes",
        source: "skill",
        skillModelVisible: true,
      }),
    );

    const expected = [{ name: "release_notes", skillDisplayName: "Mu\u0308nchen Notes" }];
    expect(getSkillCommandCompletions("M\u00dcNCHEN")).toMatchObject(expected);
    expect(getSkillCommandCompletions("release_n")).toMatchObject(expected);
  });

  it.each([false, undefined])(
    "keeps skills with visibility %j in slash commands but out of $ completions",
    (skillModelVisible) => {
      applyRemoteEntries(remoteCommand("hidden_skill", { source: "skill", skillModelVisible }));
      expectParsedSlash("/hidden_skill", { name: "hidden_skill" }, "");
      expect(getSkillCommandCompletions("hidden")).toEqual([]);
    },
  );

  it("does not let remote commands collide with reserved local commands", () => {
    applyRemoteEntries(remoteCommand("redirect"));

    expectCommand("redirect", { executeLocal: true });
  });

  it("keeps remote descriptions when a command name matches an object prototype property", () => {
    applyRemoteEntries(
      remoteCommand("constructor", {
        description: "Construct a sample project.",
      }),
    );

    const command = expectDefined(getSlashCommandCompletions("constructor")[0], "completion");
    expect(getSlashCommandDescription(command)).toBe("Construct a sample project.");
  });

  it("drops remote commands with unsafe identifiers before they reach the palette/parser", () => {
    applyRemoteEntries(
      remoteCommand("draft now", {
        textAliases: ["/draft now", "/safe-name"],
        source: "skill",
      }),
      remoteCommand("bad:alias"),
    );

    expect(SLASH_COMMANDS.find((entry) => entry.name === "draft now")).toBeUndefined();
    expect(SLASH_COMMANDS.find((entry) => entry.name === "bad:alias")).toBeUndefined();
    expectParsedSlash("/safe-name", { name: "safe-name" }, "");
  });

  it("projects argument hints and fixed choices from Gateway command entries", () => {
    applyRemoteEntries(
      remoteCommand("inspect-session", {
        args: [
          {
            name: "mode",
            description: "Mode",
            type: "string",
            required: true,
            choices: [
              { value: "brief", label: "Brief" },
              { value: "", label: "No selection" },
              { value: "full", label: "Full" },
            ],
          },
          { name: "target", description: "Target", type: "string", dynamic: true },
        ],
      }),
    );

    expectCommand("inspect-session", {
      args: "<mode> [target]",
      argOptions: ["brief", "full"],
    });
  });

  it("preserves known plugin client presentation metadata", () => {
    const clientPresentation = {
      when: "no-arguments",
      action: { kind: "device-pairing" },
    } as const;
    applyRemoteEntries(remoteCommand("pair", { clientPresentation }));
    expectCommand("pair", { clientPresentation });
  });
});
