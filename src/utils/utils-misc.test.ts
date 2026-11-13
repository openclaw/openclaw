// Misc utility tests cover small shared helper behavior.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { asBoolean, parseBooleanValue } from "./boolean.js";
import { splitCommandArgs, splitShellArgs } from "./shell-argv.js";
import { safeParseJsonWithSchema, safeParseWithSchema } from "./zod-parse.js";

describe("asBoolean", () => {
  it("accepts booleans only", () => {
    expect(asBoolean(true)).toBe(true);
    expect(asBoolean(false)).toBe(false);
    expect(asBoolean("true")).toBeUndefined();
    expect(asBoolean(1)).toBeUndefined();
  });
});

describe("parseBooleanValue", () => {
  it("handles boolean inputs", () => {
    expect(parseBooleanValue(true)).toBe(true);
    expect(parseBooleanValue(false)).toBe(false);
  });

  it("parses default truthy/falsy strings", () => {
    expect(parseBooleanValue("true")).toBe(true);
    expect(parseBooleanValue("1")).toBe(true);
    expect(parseBooleanValue("yes")).toBe(true);
    expect(parseBooleanValue("on")).toBe(true);
    expect(parseBooleanValue("false")).toBe(false);
    expect(parseBooleanValue("0")).toBe(false);
    expect(parseBooleanValue("no")).toBe(false);
    expect(parseBooleanValue("off")).toBe(false);
  });

  it("returns undefined for unsupported values", () => {
    expect(parseBooleanValue("")).toBeUndefined();
    expect(parseBooleanValue("maybe")).toBeUndefined();
    expect(parseBooleanValue(1)).toBeUndefined();
  });
});

describe("splitShellArgs", () => {
  it("supports backslash escapes inside double quotes", () => {
    expect(splitShellArgs(String.raw`echo "a\"b"`)).toEqual(["echo", `a"b`]);
    expect(splitShellArgs(String.raw`echo "\$HOME"`)).toEqual(["echo", "$HOME"]);
  });

  it("preserves empty quoted shell words and their comment boundaries", () => {
    expect(splitShellArgs(`program '' "" next`)).toEqual(["program", "", "", "next"]);
    expect(splitShellArgs(`program ""#literal ''suffix prefix''`)).toEqual([
      "program",
      "#literal",
      "suffix",
      "prefix",
    ]);
    expect(splitShellArgs(`program "" # comment`)).toEqual(["program", ""]);
  });

  it("removes POSIX line continuations outside single quotes without starting a word", () => {
    const continuation = "\\\n";
    expect(splitShellArgs(`ba${continuation}sh`)).toEqual(["bash"]);
    expect(splitShellArgs(`echo "a${continuation}b"`)).toEqual(["echo", "ab"]);
    expect(splitShellArgs(`echo a ${continuation} b`)).toEqual(["echo", "a", "b"]);
    expect(splitShellArgs(continuation)).toEqual([]);
    expect(splitShellArgs(`echo "${continuation}" ${continuation}# comment`)).toEqual(["echo", ""]);
    expect(splitShellArgs(`echo ''${continuation}#literal`)).toEqual(["echo", "#literal"]);
    expect(splitShellArgs(`echo '${continuation}'`)).toEqual(["echo", continuation]);
    expect(splitShellArgs(`ba${continuation}sh`, { rejectShellSyntax: true })).toBeNull();
    expect(splitShellArgs(`echo "a${continuation}b"`, { rejectShellSyntax: true })).toBeNull();
  });

  it("returns null for unterminated quotes", () => {
    expect(splitShellArgs(`echo "oops`)).toBeNull();
    expect(splitShellArgs(`echo 'oops`)).toBeNull();
  });

  it("stops at unquoted shell comments but keeps quoted hashes literal", () => {
    expect(splitShellArgs(`echo hi # comment && whoami`)).toEqual(["echo", "hi"]);
    expect(splitShellArgs(`echo "hi # still-literal"`)).toEqual(["echo", "hi # still-literal"]);
    expect(splitShellArgs(`echo hi#tail`)).toEqual(["echo", "hi#tail"]);
  });
});

describe("splitCommandArgs", () => {
  it("retains process-argument empty-word and backslash behavior", () => {
    expect(splitCommandArgs(`program '' "" next`)).toEqual(["program", "next"]);
    expect(splitCommandArgs("ba\\\nsh")).toEqual(["ba\\", "sh"]);
  });
  it.each(['program "unfinished'])("allows unfinished quotes when requested: %s", (raw) => {
    expect(splitCommandArgs(raw, { allowUnclosedQuotes: true })).toEqual(["program", "unfinished"]);
  });
});

describe("zod parse helpers", () => {
  const schema = z.object({ name: z.string() });

  it("returns parsed data for schema-valid values", () => {
    expect(safeParseWithSchema(schema, { name: "Ada" })).toEqual({ name: "Ada" });
    expect(safeParseJsonWithSchema(schema, `{"name":"Ada"}`)).toEqual({ name: "Ada" });
  });

  it("returns null for schema failures or invalid JSON", () => {
    expect(safeParseWithSchema(schema, { name: 1 })).toBeNull();
    expect(safeParseJsonWithSchema(schema, `{"name":1}`)).toBeNull();
    expect(safeParseJsonWithSchema(schema, `{`)).toBeNull();
  });
});
