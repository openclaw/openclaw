import { parse as parseAcorn, type Options } from "acorn";
import { describe, expect, it } from "vitest";
import { createStandaloneParser } from "../../scripts/lib/bun-standalone-parser.mjs";
import { createStandaloneSourceParser } from "../../scripts/lib/bun-standalone-source-parser.mjs";

const parsers = [
  { name: "Acorn", parse: createStandaloneParser(parseAcorn) },
  { name: "Babel ESTree", parse: createStandaloneSourceParser() },
];
const syntax: Array<{ source: string; options: Omit<Options, "ecmaVersion">; accepted: boolean }> =
  [
    { source: "return 1;", options: { sourceType: "module" }, accepted: false },
    {
      source: "return 1;",
      options: { sourceType: "module", allowReturnOutsideFunction: true },
      accepted: true,
    },
    { source: 'import "worker";', options: { sourceType: "script" }, accepted: false },
    {
      source: 'import "worker";',
      options: { sourceType: "script", allowImportExportEverywhere: true },
      accepted: true,
    },
    {
      source: "await Promise.resolve(1);",
      options: { sourceType: "script", allowAwaitOutsideFunction: false },
      accepted: false,
    },
    {
      source: "await Promise.resolve(1);",
      options: { sourceType: "script", allowAwaitOutsideFunction: true },
      accepted: true,
    },
    { source: "export { missing };", options: { sourceType: "module" }, accepted: false },
  ];

it("analyzes typed conditional arrows without moving Unicode or CRLF source spans", () => {
  const parse = createStandaloneSourceParser();
  const source =
    "// 🦞 π\r\nconst selected = enabled ? async (value: number): Promise<string> => String(value) : undefined;\r\nexport { selected };";
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const declaration = ast.body[0];
  if (!declaration || declaration.type !== "VariableDeclaration") {
    throw new Error("Missing conditional declaration");
  }
  const conditional = declaration.declarations[0]?.init;
  if (conditional?.type !== "ConditionalExpression") {
    throw new Error("Missing conditional expression");
  }
  const selected = conditional.consequent;
  if (selected.type !== "ArrowFunctionExpression") {
    throw new Error("Missing selected arrow");
  }
  const slice = (node: { start?: number | null; end?: number | null }) => {
    if (typeof node.start !== "number" || typeof node.end !== "number") {
      throw new Error("Parser omitted a source span");
    }
    return source.slice(node.start, node.end);
  };
  expect(slice(selected)).toBe("async (value: number): Promise<string> => String(value)");
  expect(slice(selected.body)).toBe("String(value)");
  const exported = ast.body[1];
  if (!exported || exported.type !== "ExportNamedDeclaration") {
    throw new Error("Missing selected export");
  }
  expect(slice(exported)).toBe("export { selected };");
  expect(() =>
    parse(
      "const selected = enabled ? async (): Promise<void> => { return broken +; } : undefined;",
      {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    ),
  ).toThrow(SyntaxError);
});

describe.each(parsers)("standalone parser consumer contract: $name", ({ parse }) => {
  it("retains statement kinds and exact Unicode/CRLF source spans", () => {
    const statements = [
      'import { Worker as TaskWorker } from "node:worker_threads";',
      'const pattern = /[🦞]/u, count = 9n, read = () => import("./child.mjs");',
      'export async function run(value) { return (await import(value)).default?.name ?? "empty"; }',
      "class Owner { #value = 7; read() { return this.#value; } }",
    ];
    const source = `#!/usr/bin/env node\r\n// π 🦞\r\n${statements.join("\r\n")}`;
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    expect(ast.body.map((node) => node.type)).toEqual([
      "ImportDeclaration",
      "VariableDeclaration",
      "ExportNamedDeclaration",
      "ClassDeclaration",
    ]);
    expect(
      ast.body.map((node) => {
        if (node.start == null || node.end == null) {
          throw new Error("Parser omitted a consumer source span");
        }
        return source.slice(node.start, node.end);
      }),
    ).toEqual(statements);
  });

  it.each(syntax)("honors consumed syntax options: $source / $options", (testCase) => {
    const run = () => parse(testCase.source, { ecmaVersion: "latest", ...testCase.options });
    if (testCase.accepted) {
      expect(run().body).toHaveLength(1);
    } else {
      expect(run).toThrow(SyntaxError);
    }
  });

  it("reports the original syntax-error offset", () => {
    let failure: unknown;
    try {
      parse("const value = ;", { ecmaVersion: "latest", sourceType: "module" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SyntaxError);
    expect(failure).toMatchObject({ pos: 14 });
  });
});
