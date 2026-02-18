import { describe, expect, it } from "vitest";
import { parseSetUnsetCommand, parseSetUnsetCommandAction } from "./commands-setunset.js";

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
