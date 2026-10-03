// Tests set/unset command parsing and config mutation replies.
import { describe, expect, it } from "vitest";
import { parseSlashCommandWithSetUnset } from "./commands-setunset.js";

function parse(raw: string) {
  return parseSlashCommandWithSetUnset({
    raw,
    slash: "/config",
    usageMessage: "Usage: /config show|set|unset",
    onKnownAction: () => undefined,
  });
}

describe("parseSlashCommandWithSetUnset", () => {
  it("returns null when the input does not match the slash command", () => {
    expect(parse("/debug show")).toBeNull();
  });

  it("returns usage errors for unknown actions and missing set paths", () => {
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
