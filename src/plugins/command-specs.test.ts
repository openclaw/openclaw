import { describe, expect, it } from "vitest";
import {
  getPluginCommandEntrySpecsFromRegistrations,
  listProviderPluginCommandSpecsFromRegistrations,
} from "./command-specs.js";
import type { PluginCommandRegistration } from "./registry-types.js";
import type { OpenClawPluginCommandDefinition } from "./types.js";

function command(
  params: Partial<OpenClawPluginCommandDefinition> & {
    name: string;
    description: string;
  },
): OpenClawPluginCommandDefinition {
  return {
    handler: async () => ({ text: "ok" }),
    ...params,
  };
}

function registration(
  commandDefinition: OpenClawPluginCommandDefinition,
): PluginCommandRegistration {
  return {
    pluginId: "demo",
    command: commandDefinition,
    pluginName: "Demo",
    source: "test",
  };
}

function unreadableCommandRegistration(): PluginCommandRegistration {
  return Object.defineProperty(
    {
      pluginId: "bad",
      pluginName: "Bad",
    },
    "command",
    {
      enumerable: true,
      get() {
        throw new Error("command registration getter exploded");
      },
    },
  ) as PluginCommandRegistration;
}

describe("plugin command specs", () => {
  it("skips unreadable command registrations while preserving healthy specs", () => {
    const badNameCommand = Object.defineProperty(
      command({ name: "bad", description: "Bad command" }),
      "name",
      {
        enumerable: true,
        get() {
          throw new Error("command name getter exploded");
        },
      },
    ) as OpenClawPluginCommandDefinition;

    const specs = getPluginCommandEntrySpecsFromRegistrations([
      unreadableCommandRegistration(),
      registration(badNameCommand),
      registration(
        command({
          name: "voice",
          description: "Voice command",
          acceptsArgs: true,
        }),
      ),
    ]);

    expect(specs).toEqual([
      {
        name: "voice",
        nativeName: "voice",
        description: "Voice command",
        acceptsArgs: true,
      },
    ]);
  });

  it("skips unreadable provider filters while preserving healthy provider specs", () => {
    const malformedChannelsCommand = command({
      name: "malformed",
      description: "Malformed command",
      channels: [123 as unknown as string],
    });
    const unreadableChannelArray = ["discord"];
    Object.defineProperty(unreadableChannelArray, "0", {
      enumerable: true,
      get() {
        throw new Error("command channel entry getter exploded");
      },
    });
    const unreadableChannelEntryCommand = command({
      name: "unreadable_entry",
      description: "Unreadable channel entry command",
      channels: unreadableChannelArray,
    });
    const badChannelsCommand = Object.defineProperty(
      command({ name: "bad", description: "Bad command" }),
      "channels",
      {
        enumerable: true,
        get() {
          throw new Error("command channels getter exploded");
        },
      },
    ) as OpenClawPluginCommandDefinition;

    const specs = listProviderPluginCommandSpecsFromRegistrations(
      [
        registration(malformedChannelsCommand),
        registration(unreadableChannelEntryCommand),
        registration(badChannelsCommand),
        registration(
          command({
            name: "voice",
            description: "Voice command",
            acceptsArgs: true,
            nativeNames: { discord: "discord_voice" },
            channels: ["discord"],
            descriptionLocalizations: { ko: "Voice command ko" },
          }),
        ),
      ],
      "discord",
    );

    expect(specs).toEqual([
      {
        name: "discord_voice",
        description: "Voice command",
        descriptionLocalizations: { ko: "Voice command ko" },
        acceptsArgs: true,
      },
    ]);
  });
});
