// Tests set/unset command parsing and config mutation replies.
import { describe, expect, it } from "vitest";
import { parseSlashCommandWithSetUnset } from "./commands-setunset.js";

type ParsedSetUnsetAction =
  | { action: "set"; path: string; value: unknown }
  | { action: "unset"; path: string }
  | { action: "error"; message: string };

function parse(raw: string) {
  return parseSlashCommandWithSetUnset<ParsedSetUnsetAction>({
    raw,
    slash: "/config",
    invalidMessage: "Invalid /config syntax.",
    usageMessage: "Usage: /config show|set|unset",
    onKnownAction: () => undefined,
    onSet: (path, value) => ({ action: "set", path, value }),
    onUnset: (path) => ({ action: "unset", path }),
    onError: (message) => ({ action: "error", message }),
  });
}

describe("parseSlashCommandWithSetUnset", () => {
  it("returns null when the input does not match the slash command", () => {
    expect(parse("/debug show")).toBeNull();
  });

  it("returns onError for unknown actions", () => {
    expect(parse("/config whoami")).toEqual({
      action: "error",
      message: "Usage: /config show|set|unset",
    });

    expect(parse("/config set")).toEqual({
      action: "error",
      message: "Usage: /config set path=value",
    });
  });
});
