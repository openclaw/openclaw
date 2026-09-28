import { describe, expect, it } from "vitest";
import { findTypecheckInertSources } from "../../scripts/lib/typecheck-inert.mts";

// One snapshot amortizes native parser startup across syntax and ASI controls.
describe("typecheck-inert TypeScript changes", () => {
  it("ignores only ordinary trivia with unchanged token and line-break boundaries", () => {
    const cases: Array<[string, string, string, boolean]> = [
      ["comment.ts", "// old\nlet x = 1;", "// new\nlet x = 1;", true],
      ["add.ts", "let x = 1;\nx++;", "let x = 1;\n// new\nx++;", true],
      ["remove.ts", "let x = 1;\n// old\nx++;", "let x = 1;\nx++;", true],
      ["indent.mts", "function f() {\n  return 1;\n}", "function f() {\n    return 1;\n}", true],
      ["spaces.cts", "let x = 1;", "let  x  =  1;", true],
      [
        "prose.d.ts",
        "/** old */\ndeclare const x: number;",
        "/** new */\ndeclare const x: number;",
        true,
      ],
      ["ambient.d.mts", "// old\nexport {};", "// new\nexport {};", true],
      [
        "add-prose-doc.ts",
        "const a = 1;\nexport const x = a;",
        "const a = 1;\n/** Added prose. */\nexport const x = a;",
        true,
      ],
      [
        "link.ts",
        'import type { Foo } from "./foo";\n/** Uses {@link Foo}. */\nexport const x = 1;',
        'import type { Foo } from "./foo";\n/** Uses Foo. */\nexport const x = 1;',
        false,
      ],
      [
        "see.ts",
        'import type { Foo } from "./foo";\n/** Old. @see Foo */\nexport const x = 1;',
        'import type { Foo } from "./foo";\n/** New. @see Foo */\nexport const x = 1;',
        false,
      ],
      [
        "attached-doc.ts",
        'import type { Foo } from "./foo";\n/** {@link Foo} */\nexport const x = 1;',
        'import type { Foo } from "./foo"; /** {@link Foo} */\nexport const x = 1;',
        false,
      ],
      [
        "tagged-doc-neighbor.ts",
        "/** @deprecated */\nexport const x = 1;\n// old\nexport const y = 2;",
        "/** @deprecated */\nexport const x = 1;\n// new\nexport const y = 2;",
        true,
      ],
      [
        "moved-doc.ts",
        "/** @deprecated */\nexport const x = 1;\nexport const y = 2;",
        "export const x = 1;\n/** @deprecated */\nexport const y = 2;",
        false,
      ],
      ["ambient.d.cts", "// old\nexport {};", "// new\nexport {};", true],
      ["return.ts", "function f() { return x; }", "function f() { return\nx; }", false],
      [
        "block.ts",
        "function f() { return /* a */ x; }",
        "function f() { return /*\n*/ x; }",
        false,
      ],
      [
        "unicode.ts",
        "function f() { return /* a */ x; }",
        "function f() { return /*\u2028*/ x; }",
        false,
      ],
      [
        "rescan.ts",
        "declare let a: any, b: any, c: any;\nexport const r = a < b >= c;",
        "declare let a: any, b: any, c: any;\nexport const r = a < b > = c;",
        false,
      ],
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
      [
        "upper-directive.ts",
        "// @TS-NOCHECK\nconst x: string = 1;",
        "// ok\nconst x: string = 1;",
        false,
      ],
      ["upper-jsx.tsx", "/** @JSX h */\nx(); // old", "/** @JSX h */\nx(); // new", false],
      [
        "reference.ts",
        '/// <reference path="a.ts" />\n// old',
        '/// <reference path="a.ts" />\n// new',
        false,
      ],
      ["invalid-before.ts", "let = ; // old", "let x = 1; // new", false],
      ["invalid-after.ts", "let x = 1; // old", "let = ; // new", false],
      ["invalid-both.ts", "let = ; // old", "let = ; // new", false],
      [
        "hashbang.ts",
        "#!/usr/bin/env node\n// old\nx();",
        "#!/usr/bin/env node\n// new\nx();",
        false,
      ],
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
});
