import { describe, expect, it } from "vitest";
import { decodeLegacyBusctlOutput } from "./systemd-busctl-legacy.js";

describe("decodeLegacyBusctlOutput", () => {
  it.each([
    ['s ":1.42"\n', "s", ":1.42"],
    ['o "/"', "o", "/"],
    ["u 4294967295", "u", 4294967295],
    ["a(sb) 0", "a(sb)", []],
  ])("wraps method reply %s", (stdout, signature, value) => {
    expect(decodeLegacyBusctlOutput(stdout, [signature], true)).toEqual([[value]]);
  });

  it("decodes multiple flattened executions, empty arguments, and numeric boundaries", () => {
    const stdout =
      'a(sasbttttuii) 2 "/x" 2 "a b" "" false 0 1 2 3 4294967295 -2147483648 2147483647 "/y" 0 true 0 0 0 18446744073709551615 0 0 -1';
    expect(decodeLegacyBusctlOutput(stdout, ["a(sasbttttuii)"], false)).toEqual([
      [
        ["/x", ["a b", ""], false, 0, 1, 2, 3, 4294967295, -2147483648, 2147483647],
        ["/y", [], true, 0, 0, 0, Number(18446744073709551615n), 0, 0, -1],
      ],
    ]);
  });

  it("decodes v239 C escapes as bytes before UTF-8, preserving BOM and literal escapes", () => {
    const output = String.raw`s "\357\273\277caf\303\251 \360\237\220\231 \a\b\f\n\r\t\v\'\"\\n"`;
    expect(decodeLegacyBusctlOutput(output, ["s"], false)).toEqual([
      "\uFEFFcafé 🐙 \x07\b\f\n\r\t\v'\"\\n",
    ]);
  });

  it.each([
    ["", ["s"]],
    ['s "x"', []],
    ['s "x"', ["o"]],
    ['s "x"\ns "y"', ["s"]],
    ['s "x"\n\n', ["s"]],
    ['s "x"', ["s", "s"]],
    ['s "x" extra', ["s"]],
    ['s "x" ', ["s"]],
    ['s "x""y"', ["s"]],
    ['s "unterminated', ["s"]],
    ["s unquoted", ["s"]],
    ['s  "x"', ["s"]],
    ['s "literal\nnewline"', ["s"]],
    ['s "literalé"', ["s"]],
    [String.raw`s "\000"`, ["s"]],
    [String.raw`s "\400"`, ["s"]],
    [String.raw`s "\12"`, ["s"]],
    [String.raw`s "\x41"`, ["s"]],
    [String.raw`s "\u0041"`, ["s"]],
    [String.raw`s "\q"`, ["s"]],
    [String.raw`s "\377"`, ["s"]],
    [String.raw`s "\303"`, ["s"]],
    [String.raw`s "\300\200"`, ["s"]],
    [String.raw`s "\355\240\200"`, ["s"]],
    ['o "relative"', ["o"]],
    ['o "/bad-path"', ["o"]],
    ['o "/trailing/"', ["o"]],
    ["b 1", ["b"]],
    ["b True", ["b"]],
    ["u -1", ["u"]],
    ["u 4294967296", ["u"]],
    ["u 1e3", ["u"]],
    ["u 01", ["u"]],
    ["a{ss} 0", ["a{ss}"]],
    ["as 16384", ["as"]],
    ['as 2 "only one"', ["as"]],
    ['as 0 "extra"', ["as"]],
    ['a(sb) 1 "/x"', ["a(sb)"]],
    ['a(sb) 1 "/x" 0', ["a(sb)"]],
    ['a(sasbttttuii) 1 "/x" 0 false 0 0 0 18446744073709551616 0 0 0', ["a(sasbttttuii)"]],
    ['a(sasbttttuii) 1 "/x" 0 false 0 0 0 -1 0 0 0', ["a(sasbttttuii)"]],
    ['a(sasbttttuii) 1 "/x" 0 false 0 0 0 0 0 -2147483649 0', ["a(sasbttttuii)"]],
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
