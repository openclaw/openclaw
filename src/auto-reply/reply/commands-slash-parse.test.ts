// Tests slash command parsing boundaries, defaults, and argument preservation.
import { describe, expect, it } from "vitest";
import { parseSlashCommandOrNull } from "./commands-slash-parse.js";

describe("parseSlashCommandOrNull", () => {
  it("returns null when the input doesn't start with the slash prefix", () => {
    expect(parseSlashCommandOrNull("hello world", "/config")).toBeNull();
  });

  it.each([
    ["/config show enabled", "show", "enabled"],
    ["/CONFIG\tSET a=1\n  b=2", "set", "a=1\n  b=2"],
    ["/config\u2028show  enabled\nagain", "show", "enabled\nagain"],
    ["/config:json", ":json", ""],
  ])("preserves arguments after the action in %j", (raw, action, args) => {
    expect(parseSlashCommandOrNull(raw, "/config")).toEqual({ action, args });
  });

  it("returns the default action on an empty body", () => {
    expect(parseSlashCommandOrNull("/config", "/config")).toEqual({ action: "show", args: "" });
    expect(parseSlashCommandOrNull("/config", "/config", "status")).toEqual({
      action: "status",
      args: "",
    });
  });

  describe("regression: #84572 — prefix match must require a word boundary", () => {
    // Previously, `/config-check <args>` matched the `/config` handler
    // via a naive `startsWith` and surfaced as an invalid action, blocking
    // any skill whose name shared a prefix with a built-in command.
    it("does not match a longer command name with a hyphen tail (`/config-check`)", () => {
      expect(parseSlashCommandOrNull("/config-check arg1 arg2", "/config")).toBeNull();
    });

    it("does not match a longer command name with no whitespace after prefix", () => {
      expect(parseSlashCommandOrNull("/configfoo", "/config")).toBeNull();
    });

    it("still matches the exact prefix with leading whitespace", () => {
      const result = parseSlashCommandOrNull("  /config show ", "/config");
      expect(result).toEqual({ action: "show", args: "" });
    });
  });
});
