import { ApplicationCommandOptionType } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import type { ChatCommandDefinition } from "../../auto-reply/commands-registry.types.js";
import { buildDiscordCommandOptions } from "./native-command.js";

describe("buildDiscordCommandOptions — autocomplete for choices (#32753)", () => {
  const baseCfg = {} as ReturnType<typeof import("../../config/config.js").loadConfig>;

  function makeCommand(overrides?: Partial<ChatCommandDefinition>): ChatCommandDefinition {
    return {
      name: "test",
      nativeName: "test",
      description: "test command",
      args: [
        {
          name: "action",
          description: "action to perform",
          type: "string",
          choices: ["close", "pause", "resume", "status"],
        },
      ],
      ...overrides,
    } as ChatCommandDefinition;
  }

  it("uses autocomplete (not static choices) when arg has choices under 25", () => {
    const command = makeCommand();
    const options = buildDiscordCommandOptions({ command, cfg: baseCfg });
    expect(options).toBeDefined();
    expect(options!.length).toBe(1);

    const opt = options![0] as {
      name: string;
      type: number;
      choices?: unknown[];
      autocomplete?: unknown;
    };
    expect(opt.name).toBe("action");
    expect(opt.type).toBe(ApplicationCommandOptionType.String);
    // Must use autocomplete, NOT static choices — static choices cause
    // Discord to send null for typed-in values like `/acp close`.
    expect(opt.autocomplete).toBeDefined();
    expect(typeof opt.autocomplete).toBe("function");
    expect(opt.choices).toBeUndefined();
  });

  it("uses autocomplete when arg has more than 25 choices", () => {
    const manyChoices = Array.from({ length: 30 }, (_, i) => `choice-${i}`);
    const command = makeCommand({
      args: [
        {
          name: "action",
          description: "action to perform",
          type: "string",
          choices: manyChoices,
        },
      ],
    });
    const options = buildDiscordCommandOptions({ command, cfg: baseCfg });
    expect(options).toBeDefined();
    const opt = options![0] as { choices?: unknown[]; autocomplete?: unknown };
    expect(opt.autocomplete).toBeDefined();
    expect(opt.choices).toBeUndefined();
  });

  it("does not use autocomplete when arg has no choices", () => {
    const command = makeCommand({
      args: [
        {
          name: "input",
          description: "free text input",
          type: "string",
        },
      ],
    });
    const options = buildDiscordCommandOptions({ command, cfg: baseCfg });
    expect(options).toBeDefined();
    const opt = options![0] as { choices?: unknown[]; autocomplete?: unknown };
    expect(opt.autocomplete).toBeUndefined();
    expect(opt.choices).toBeUndefined();
  });
});
