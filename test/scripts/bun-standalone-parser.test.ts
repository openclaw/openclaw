import { parse as parseAcorn, type Options, type Token } from "acorn";
import { describe, expect, it, vi } from "vitest";
import { createStandaloneParser } from "../../scripts/lib/bun-standalone-parser.mjs";

describe("standalone parser reuse", () => {
  it("parses identical source and order-independent options once", () => {
    const owner = vi.fn(parseAcorn);
    const parse = createStandaloneParser(owner);
    const source = "export const value = 1;";
    const first = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    expect(first.body[0]?.type).toBe("ExportNamedDeclaration");
    expect(parse(source, { sourceType: "module", ecmaVersion: "latest" })).toBe(first);
    expect(owner).toHaveBeenCalledTimes(1);
  });

  it("retains only the last successful source", () => {
    const owner = vi.fn(parseAcorn);
    const parse = createStandaloneParser(owner);
    const options: Options = { ecmaVersion: "latest", sourceType: "module" };
    parse("const first = 1;", options);
    parse("const second = 2;", options);
    parse("const first = 1;", options);
    expect(owner).toHaveBeenCalledTimes(3);
  });

  it("propagates errors for changed source and options without caching failures", () => {
    const owner = vi.fn(parseAcorn);
    const parse = createStandaloneParser(owner);
    const options: Options = { ecmaVersion: "latest", allowReturnOutsideFunction: true };
    const source = "return 1;";
    const valid = parse(source, options);
    expect(() => parse("return (;", options)).toThrow(SyntaxError);
    expect(() => parse(source, { ...options, allowReturnOutsideFunction: false })).toThrow(
      "'return' outside of function",
    );
    expect(() => parse(source, { ...options, allowReturnOutsideFunction: false })).toThrow(
      "'return' outside of function",
    );
    expect(parse(source, options)).toBe(valid);
    expect(owner).toHaveBeenCalledTimes(4);
  });

  it("snapshots options before callers mutate the object", () => {
    const owner = vi.fn(parseAcorn);
    const parse = createStandaloneParser(owner);
    const options: Options = { ecmaVersion: "latest", sourceType: "module" };
    parse("export {};", options);
    options.sourceType = "script";
    expect(() => parse("export {};", options)).toThrow(
      "'import' and 'export' may appear only with 'sourceType: module'",
    );
    expect(owner).toHaveBeenCalledTimes(2);
  });

  it("keeps every primitive option in the identity, including missing and undefined", () => {
    const owner = vi.fn(parseAcorn);
    const parse = createStandaloneParser(owner);
    const options: Options = { ecmaVersion: "latest" };
    for (const value of [false, undefined, null, 0, -0, ""]) {
      const extendedOptions = { ...options, unused: value };
      parse("const value = 1;", extendedOptions);
    }
    parse("const value = 1;", options);
    expect(owner).toHaveBeenCalledTimes(7);
  });

  it("runs parser callbacks on every call and clears an earlier reusable result", () => {
    const owner = vi.fn(parseAcorn);
    const parse = createStandaloneParser(owner);
    const options: Options = { ecmaVersion: "latest" };
    const source = "const value = 1;";
    parse(source, options);
    const tokens: Token[] = [];
    parse(source, { ...options, onToken: tokens });
    parse(source, { ...options, onToken: tokens });
    expect(tokens.map((token) => token.type.label)).toEqual([
      "const",
      "name",
      "=",
      "num",
      ";",
      "eof",
      "const",
      "name",
      "=",
      "num",
      ";",
      "eof",
    ]);
    parse(source, options);
    expect(owner).toHaveBeenCalledTimes(4);
  });

  it("leaves accessor options to Acorn without additional getter reads", () => {
    const parse = createStandaloneParser(parseAcorn);
    let reads = 0;
    const options: Options = {
      ecmaVersion: "latest",
      get sourceType(): "module" {
        reads += 1;
        return "module";
      },
    };
    parse("export {};", options);
    parse("export {};", options);
    expect(reads).toBe(2);
  });
});
