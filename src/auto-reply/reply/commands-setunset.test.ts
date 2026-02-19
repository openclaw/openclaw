import { describe, expect, it } from "vitest";
import { parseStandardSetUnsetSlashCommand } from "./commands-setunset-standard.js";
import {
  parseSetUnsetCommand,
  parseSetUnsetCommandAction,
  parseSlashCommandWithSetUnset,
} from "./commands-setunset.js";

type ParsedSetUnsetAction =
  | { action: "set"; path: string; value: unknown }
  | { action: "unset"; path: string }
  | { action: "error"; message: string };

describe("parseSetUnsetCommand", () => {
  it("parses unset values", () => {
    expect(
      parseSetUnsetCommand({
        slash: "/config",
        action: "unset",
        args: "foo.bar",
      }),
    ).toEqual({ kind: "unset", path: "foo.bar" });
  });

  it("parses set values", () => {
    expect(
      parseSetUnsetCommand({
        slash: "/config",
        action: "set",
        args: 'foo.bar={"x":1}',
      }),
    ).toEqual({ kind: "set", path: "foo.bar", value: { x: 1 } });
  });
});

describe("parseSetUnsetCommandAction", () => {
  it("returns null for non set/unset actions", () => {
    const result = parseSetUnsetCommandAction<ParsedSetUnsetAction>({
      slash: "/config",
      action: "show",
      args: "",
      onSet: (path, value) => ({ action: "set", path, value }),
      onUnset: (path) => ({ action: "unset", path }),
      onError: (message) => ({ action: "error", message }),
    });
    expect(result).toBeNull();
  });

  it("maps parse errors through onError", () => {
    const result = parseSetUnsetCommandAction<ParsedSetUnsetAction>({
      slash: "/config",
      action: "set",
      args: "",
      onSet: (path, value) => ({ action: "set", path, value }),
      onUnset: (path) => ({ action: "unset", path }),
      onError: (message) => ({ action: "error", message }),
    });
    expect(result).toEqual({ action: "error", message: "Usage: /config set path=value" });
  });
});

describe("parseSlashCommandWithSetUnset", () => {
  it("returns null when the input does not match the slash command", () => {
    const result = parseSlashCommandWithSetUnset<ParsedSetUnsetAction>({
      raw: "/debug show",
      slash: "/config",
      invalidMessage: "Invalid /config syntax.",
      usageMessage: "Usage: /config show|set|unset",
      onKnownAction: () => undefined,
      onSet: (path, value) => ({ action: "set", path, value }),
      onUnset: (path) => ({ action: "unset", path }),
      onError: (message) => ({ action: "error", message }),
    });
    expect(result).toBeNull();
  });

  it("prefers set/unset mapping and falls back to known actions", () => {
    const setResult = parseSlashCommandWithSetUnset<ParsedSetUnsetAction>({
      raw: '/config set a.b={"ok":true}',
      slash: "/config",
      invalidMessage: "Invalid /config syntax.",
      usageMessage: "Usage: /config show|set|unset",
      onKnownAction: () => undefined,
      onSet: (path, value) => ({ action: "set", path, value }),
      onUnset: (path) => ({ action: "unset", path }),
      onError: (message) => ({ action: "error", message }),
    });
    expect(setResult).toEqual({ action: "set", path: "a.b", value: { ok: true } });

    const showResult = parseSlashCommandWithSetUnset<ParsedSetUnsetAction>({
      raw: "/config show",
      slash: "/config",
      invalidMessage: "Invalid /config syntax.",
      usageMessage: "Usage: /config show|set|unset",
      onKnownAction: (action) =>
        action === "show" ? { action: "unset", path: "dummy" } : undefined,
      onSet: (path, value) => ({ action: "set", path, value }),
      onUnset: (path) => ({ action: "unset", path }),
      onError: (message) => ({ action: "error", message }),
    });
    expect(showResult).toEqual({ action: "unset", path: "dummy" });
  });

  it("returns onError for unknown actions", () => {
    const unknownAction = parseSlashCommandWithSetUnset<ParsedSetUnsetAction>({
      raw: "/config whoami",
      slash: "/config",
      invalidMessage: "Invalid /config syntax.",
      usageMessage: "Usage: /config show|set|unset",
      onKnownAction: () => undefined,
      onSet: (path, value) => ({ action: "set", path, value }),
      onUnset: (path) => ({ action: "unset", path }),
      onError: (message) => ({ action: "error", message }),
    });
    expect(unknownAction).toEqual({ action: "error", message: "Usage: /config show|set|unset" });
  });
});

describe("parseStandardSetUnsetSlashCommand", () => {
  it("uses default set/unset/error mappings", () => {
    const result = parseStandardSetUnsetSlashCommand<ParsedSetUnsetAction>({
      raw: '/config set a.b={"ok":true}',
      slash: "/config",
      invalidMessage: "Invalid /config syntax.",
      usageMessage: "Usage: /config show|set|unset",
      onKnownAction: () => undefined,
    });
    expect(result).toEqual({ action: "set", path: "a.b", value: { ok: true } });
  });

  it("supports caller-provided mappings", () => {
    const result = parseStandardSetUnsetSlashCommand<ParsedSetUnsetAction>({
      raw: "/config unset a.b",
      slash: "/config",
      invalidMessage: "Invalid /config syntax.",
      usageMessage: "Usage: /config show|set|unset",
      onKnownAction: () => undefined,
      onUnset: (path) => ({ action: "unset", path: `wrapped:${path}` }),
    });
    expect(result).toEqual({ action: "unset", path: "wrapped:a.b" });
  });
});
