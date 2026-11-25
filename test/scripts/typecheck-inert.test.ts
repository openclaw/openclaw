import { expect, it } from "vitest";
import { findTypecheckInertSources } from "../../scripts/lib/typecheck-inert.mts";

type Change = [string, string, string, boolean];
function edit(path: string, before: string, from: string, to: string, inert = false): Change {
  return [path, before, before.replace(from, to), inert];
}
const importFoo = 'import type { Foo } from "./foo";';
const returnValue = "function f() { return /* a */ x; }";

// One snapshot amortizes native parser startup across syntax and ASI controls.
it("ignores only ordinary trivia with unchanged token and line-break boundaries", () => {
  const cases: Change[] = [
    ["comment.ts", "// old\nlet x = 1;", "// new\nlet x = 1;", true],
    ["add.ts", "let x = 1;\nx++;", "let x = 1;\n// new\nx++;", true],
    ["remove.ts", "let x = 1;\n// old\nx++;", "let x = 1;\nx++;", true],
    ["indent.mts", "function f() {\n  return 1;\n}", "function f() {\n    return 1;\n}", true],
    ["spaces.cts", "let x = 1;", "let  x  =  1;", true],
    edit("prose.d.ts", "/** old */\ndeclare const x: number;", "old", "new", true),
    ["ambient.d.mts", "// old\nexport {};", "// new\nexport {};", true],
    edit(
      "add-prose-doc.ts",
      "const a = 1;\nexport const x = a;",
      "\n",
      "\n/** Added prose. */\n",
      true,
    ),
    edit(
      "link.ts",
      `${importFoo}\n/** Uses {@link Foo}. */\nexport const x = 1;`,
      "{@link Foo}",
      "Foo",
    ),
    edit("see.ts", `${importFoo}\n/** Old. @see Foo */\nexport const x = 1;`, "Old", "New"),
    edit("attached-doc.ts", `${importFoo}\n/** {@link Foo} */\nexport const x = 1;`, ";\n", "; "),
    edit(
      "tagged-doc-neighbor.ts",
      "/** @deprecated */\nexport const x = 1;\n// old\nexport const y = 2;",
      "old",
      "new",
      true,
    ),
    edit(
      "moved-doc.ts",
      "/** @deprecated */\nexport const x = 1;\nexport const y = 2;",
      "/** @deprecated */\nexport const x = 1;",
      "export const x = 1;\n/** @deprecated */",
    ),
    ["ambient.d.cts", "// old\nexport {};", "// new\nexport {};", true],
    ["return.ts", "function f() { return x; }", "function f() { return\nx; }", false],
    edit("block.ts", returnValue, "/* a */", "/*\n*/"),
    edit("unicode.ts", returnValue, "/* a */", "/*\u2028*/"),
    edit("rescan.ts", "export const r = a < b >= c;", ">=", "> ="),
    ["adjacent.ts", "let x = a+b;", "let x = a + b;", false],
    ["adjacent-comment.ts", "let x = a+b;", "let x = a/* c */+b;", false],
    ["string.ts", 'let x = "a";', 'let x = "b";', false],
    ["template.ts", "let x = `a${1}b${2}c`;", "let x = `a${1} b${2}c`;", false],
    ["template-tail.ts", "let x = `a${1}b`;", "let x = `a${1} b`;", false],
    ["regex.ts", "let x = /a/;", "let x = /b/;", false],
    ["jsx.tsx", "let x = <p> text </p>;", "let x = <p>  text </p>;", false],
    ["jsx-space.tsx", "let x = <p> </p>;", "let x = <p>  </p>;", false],
    ["keyword.ts", "let x = 1;", "const x = 1;", false],
    ["add-directive.ts", "\nx();", "// @ts-expect-error\nx();", false],
    ["remove-directive.ts", "// @ts-expect-error\nx();", "\nx();", false],
    ["existing-directive.ts", "// @ts-ignore\nx(); // old", "// @ts-ignore\nx(); // new", false],
    ["jsx-directive.tsx", "/** @jsx h */\nx(); // old", "/** @jsx h */\nx(); // new", false],
    edit("upper-directive.ts", "// @TS-NOCHECK\nconst x: string = 1;", "@TS-NOCHECK", "ok"),
    ["upper-jsx.tsx", "/** @JSX h */\nx(); // old", "/** @JSX h */\nx(); // new", false],
    edit("reference.ts", '/// <reference path="a.ts" />\n// old', "old", "new"),
    ["invalid-before.ts", "let = ; // old", "let x = 1; // new", false],
    ["invalid-after.ts", "let x = 1; // old", "let = ; // new", false],
    ["invalid-both.ts", "let = ; // old", "let = ; // new", false],
    edit("hashbang.ts", "#!/usr/bin/env node\n// old\nx();", "old", "new"),
    ...["js", "jsx", "mjs", "cjs"].map((ext): [string, string, string, boolean] => [
      `javascript.${ext}`,
      "/** old */\nlet x = 1;",
      "/** new */\nlet x = 1;",
      false,
    ]),
    [
      "literal-comments.ts",
      'const x = "@ts-ignore"; const y = /\\/\\//; const z = `/* raw */${1 /* old */}`;',
      'const x = "@ts-ignore"; const y = /\\/\\//; const z = `/* raw */${1 /* new */}`;',
      true,
    ],
    ["crlf.ts", "// old\r\nlet x = 1;", "// new\nlet x = 1;", true],
  ];
  const inert = findTypecheckInertSources(
    cases.map(([path, before, after]) => ({ path, before, after })),
  );
  expect(inert).toEqual(cases.filter((entry) => entry[3]).map(([path]) => path));
});
