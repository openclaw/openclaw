// Tests slash command parsing boundaries and defaults.
import { describe, expect, it } from "vitest";
import { parseSlashCommandOrNull } from "./commands-slash-parse.js";

describe("parseSlashCommandOrNull", () => {
  it("returns null when the input doesn't start with the slash prefix", () => {
    expect(parseSlashCommandOrNull("hello world", "/config")).toBeNull();
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
  });
});
