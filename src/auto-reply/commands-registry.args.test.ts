import { describe, expect, it } from "vitest";

import {
  buildCommandTextFromArgs,
  parseCommandArgs,
  resolveCommandArgMenu,
  serializeCommandArgs,
} from "./commands-registry.js";
import type { ChatCommandDefinition } from "./commands-registry.types.js";

describe("commands registry args", () => {
  it("parses positional args and captureRemaining", () => {
    const command: ChatCommandDefinition = {
      key: "debug",
      description: "debug",
      textAliases: [],
      scope: "both",
      argsParsing: "positional",
      args: [
        { name: "action", description: "action", type: "string" },
        { name: "path", description: "path", type: "string" },
        { name: "value", description: "value", type: "string", captureRemaining: true },
      ],
    };

    const args = parseCommandArgs(command, "set foo bar baz");
    expect(args?.values).toEqual({ action: "set", path: "foo", value: "bar baz" });
  });

  it("serializes args via raw first, then values", () => {
    const command: ChatCommandDefinition = {
      key: "model",
      description: "model",
      textAliases: [],
      scope: "both",
      argsParsing: "positional",
      args: [{ name: "model", description: "model", type: "string", captureRemaining: true }],
    };

    expect(serializeCommandArgs(command, { raw: "gpt-5.2-codex" })).toBe("gpt-5.2-codex");
    expect(serializeCommandArgs(command, { values: { model: "gpt-5.2-codex" } })).toBe(
      "gpt-5.2-codex",
    );
    expect(buildCommandTextFromArgs(command, { values: { model: "gpt-5.2-codex" } })).toBe(
      "/model gpt-5.2-codex",
    );
  });

  it("resolves auto arg menus when missing a choice arg", () => {
    const command: ChatCommandDefinition = {
      key: "cost",
      description: "cost",
      textAliases: [],
      scope: "both",
      argsMenu: "auto",
      argsParsing: "positional",
      args: [
        {
          name: "mode",
          description: "mode",
          type: "string",
          choices: ["on", "off"],
        },
      ],
    };

    const menu = resolveCommandArgMenu({ command, args: undefined, cfg: {} as never });
    expect(menu?.arg.name).toBe("mode");
    expect(menu?.choices).toEqual(["on", "off"]);
  });

  it("does not show menus when arg already provided", () => {
    const command: ChatCommandDefinition = {
      key: "cost",
      description: "cost",
      textAliases: [],
      scope: "both",
      argsMenu: "auto",
      argsParsing: "positional",
      args: [
        {
          name: "mode",
          description: "mode",
          type: "string",
          choices: ["on", "off"],
        },
      ],
    };

    const menu = resolveCommandArgMenu({
      command,
      args: { values: { mode: "on" } },
      cfg: {} as never,
    });
    expect(menu).toBeNull();
  });
});
