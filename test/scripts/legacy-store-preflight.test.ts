import * as ts from "typescript/unstable/ast";
import { afterAll, describe, expect, it } from "vitest";
import { createLegacyStorePreflightBindingProof } from "../../scripts/lib/legacy-store-preflight.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";

const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

const detection = '[path.join(stateDir, "restart-sentinel.json")].some(fs.existsSync)';
const imported = `import fs from "node:fs";`;

const cases: Array<[string, string, boolean]> = [
  ["default import", `${imported} ${detection};`, true],
  ["namespace import", `import * as fs from "node:fs"; ${detection};`, false],
  ["named default import", `import { default as fs } from "node:fs"; ${detection};`, false],
  ["promises import", `import { promises as fs } from "node:fs"; ${detection};`, false],
  ["type-only import", `import type fs from "node:fs"; ${detection};`, false],
  ["CommonJS require", `const fs = require("node:fs"); ${detection};`, false],
  ["alternate module specifier", `import fs from "fs"; ${detection};`, false],
  ["parameter", `${imported} function run(fs) { return ${detection}; }`, false],
  ["destructured parameter", `${imported} function run({ fs }) { return ${detection}; }`, false],
  ["later lexical declaration", `${imported} function run() { ${detection}; let fs; }`, false],
  [
    "hoisted var in nested block",
    `${imported} function run() { ${detection}; { var fs; } }`,
    false,
  ],
  ["sibling block binding", `${imported} { let fs; } ${detection};`, true],
  ["catch parameter", `${imported} try {} catch (fs) { ${detection}; }`, false],
  ["destructured catch parameter", `${imported} try {} catch ({ fs }) { ${detection}; }`, false],
  ["for-of binding", `${imported} for (const fs of values) { ${detection}; }`, false],
  [
    "hoisted for var",
    `${imported} function run() { for (var fs of values) {} ${detection}; }`,
    false,
  ],
  ["function declaration", `${imported} function run() { ${detection}; function fs() {} }`, false],
  [
    "named function expression",
    `${imported} const run = function fs() { return ${detection}; };`,
    false,
  ],
  ["class declaration", `${imported} function run() { ${detection}; class fs {} }`, false],
  [
    "named class expression",
    `${imported} const cls = class fs { method() { return ${detection}; } };`,
    false,
  ],
  ["namespace value", `${imported} namespace N { ${detection}; const fs = {}; }`, false],
  ["reassigned import", `${imported} fs = custom; ${detection};`, true],
  ["type alias", `${imported} function run() { type fs = string; return ${detection}; }`, true],
  ["interface", `${imported} function run() { interface fs {} return ${detection}; }`, true],
  ["enum declaration", `${imported} function run() { ${detection}; enum fs {} }`, false],
  [
    "parameter default before body var",
    `${imported} function run(value = ${detection}) { var fs; }`,
    true,
  ],
  ["module declaration conflict", `${imported} const fs = {}; ${detection};`, true],
  [
    "type-only namespace",
    `${imported} function run() { namespace fs { export type X = string; } return ${detection}; }`,
    true,
  ],
  [
    "value-bearing namespace",
    `${imported} function run() { namespace fs { export const X = 1; } return ${detection}; }`,
    false,
  ],
  [
    "switch scope",
    `${imported} switch (value) { case 0: ${detection}; break; default: let fs; }`,
    false,
  ],
];

describe("legacy-store preflight import binding", () => {
  it.each(cases)("preserves the native binding result for %s", (_name, content, expected) => {
    const source = parser.parseSourceFile("preflight.ts", content);
    const proveBinding = createLegacyStorePreflightBindingProof(source);
    const results: boolean[] = [];
    function visit(node: ts.Node): void {
      if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === "existsSync" &&
        ts.isIdentifier(node.expression)
      ) {
        results.push(proveBinding(node.expression));
      }
      node.forEachChild(visit);
    }
    visit(source);
    expect(results).toEqual([expected]);
  });
});
