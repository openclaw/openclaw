import { describe, expect, it } from "vitest";
import { decodeLegacyBusctlOutput } from "./systemd-busctl-legacy.js";

describe("decodeLegacyBusctlOutput", () => {
  it.each([["u 4294967295", "u", 4294967295]])(
    "wraps method reply %s",
    (stdout, signature, value) => {
      expect(decodeLegacyBusctlOutput(stdout, [signature], true)).toEqual([[value]]);
    },
  );

  it("decodes v239 C escapes as bytes before UTF-8, preserving BOM and literal escapes", () => {
    const output = String.raw`s "\357\273\277caf\303\251 \360\237\220\231 \a\b\f\n\r\t\v\'\"\\n"`;
    expect(decodeLegacyBusctlOutput(output, ["s"], false)).toEqual([
      "\uFEFFcafé 🐙 \x07\b\f\n\r\t\v'\"\\n",
    ]);
  });

  it.each([
    ['s "x"', ["o"]],
    ['s "x"', ["s", "s"]],
    ['s "unterminated', ["s"]],
    ["s unquoted", ["s"]],
    ['s "literalé"', ["s"]],
    [String.raw`s "\000"`, ["s"]],
    [String.raw`s "\x41"`, ["s"]],
    ['o "relative"', ["o"]],
    ["u 1e3", ["u"]],
    ["as 16384", ["as"]],
    ['as 0 "extra"', ["as"]],
    ['a(sb) 1 "/x"', ["a(sb)"]],
    ['a(sb) 1 "/x" 0', ["a(sb)"]],
    ['a(sasbttttuii) 1 "/x" 0 false 0 0 0 0 0 0 2147483648', ["a(sasbttttuii)"]],
  ])("rejects malformed or unsupported output %s", (stdout, signatures) => {
    expect(() =>
      decodeLegacyBusctlOutput(stdout as string, signatures as string[], false),
    ).toThrow();
  });

  it("bounds total values across lines and nested containers", () => {
    const array = `as 16383${' ""'.repeat(16383)}`;
    expect((decodeLegacyBusctlOutput(array, ["as"], false)[0] as string[]).length).toBe(16383);
    expect(() => decodeLegacyBusctlOutput(`${array}\ns ""`, ["as", "s"], false)).toThrow();
    expect(() =>
      decodeLegacyBusctlOutput(`a(sb) 6000${' "" false'.repeat(6000)}`, ["a(sb)"], false),
    ).toThrow();
  });

  it("bounds output bytes before decoding", () => {
    const limit = 1024 * 1024;
    expect(decodeLegacyBusctlOutput(`s "${"x".repeat(limit - 4)}"`, ["s"], false)).toHaveLength(1);
    expect(() => decodeLegacyBusctlOutput(`s "${"x".repeat(limit - 3)}"`, ["s"], false)).toThrow();
  });
});
