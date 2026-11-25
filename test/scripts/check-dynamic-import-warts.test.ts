import { afterAll, expect, it } from "vitest";
import { findDynamicImportAdvisories } from "../../scripts/check-dynamic-import-warts.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";

const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());
const start = 'export async function start() { return await import("./runtime.js"); }';
const loader = `let runtimePromise: Promise<typeof import("./runtime.js")> | undefined;
function loadRuntime() { return runtimePromise ??= import("./runtime.js"); }`;
function advisories(source: string) {
  return findDynamicImportAdvisories(source, "file.ts", parser.parseSourceFile("file.ts", source));
}
function runtimeMix(title: string, source: string, staticLine: number) {
  return {
    title,
    source,
    line: 2,
    reason: `runtime static + dynamic import of "./runtime.js" (static line ${staticLine})`,
  };
}

it.each([
  runtimeMix("flags static imports", 'import { run } from "./runtime.js";\n' + start, 1),
  runtimeMix("flags static re-exports", loader + '\nexport { run } from "./runtime.js";', 3),
  runtimeMix(
    "flags mixed runtime and type re-exports",
    loader + '\nexport { type Runtime, createRuntime } from "./runtime.js";',
    3,
  ),
  {
    title: "flags repeated direct dynamic imports",
    source: start + '\nexport async function two() { return await import("./runtime.js"); }',
    line: 1,
    reason: 'repeated direct dynamic import of "./runtime.js" (2 callsites: 1, 2)',
  },
])("$title", ({ source, line, reason }) => {
  expect(advisories(source)).toEqual([{ line, reason }]);
});

it.each([
  [
    "ignores type-only static imports",
    'import { type Runtime } from "./runtime.js";\nexport async function start(): Promise<Runtime> { return (await import("./runtime.js")).createRuntime(); }',
  ],
  ["ignores type-only static re-exports", 'export type { Runtime } from "./runtime.js";\n' + start],
  [
    "ignores inline type-only static re-exports",
    'export { type Runtime, type RuntimeOptions } from "./runtime.js";\n' + start,
  ],
  [
    "ignores local export declarations without module specifiers",
    "const run = true; export { run };\n" + start,
  ],
  [
    "allows execute paths that call cached loaders",
    loader +
      "\nexport function createTool() { return { execute: async () => await loadRuntime() }; }",
  ],
])("%s", (_title, source) => {
  expect(advisories(source)).toStrictEqual([]);
});

it("flags direct dynamic imports inside execute paths", () => {
  const source = `export function createTool() {
  return { execute: async () => { return await import("./runtime.js"); } };
}`;
  expect(advisories(source)).toEqual([
    {
      line: 2,
      reason:
        'direct dynamic import of "./runtime.js" inside execute path; move it behind a cached loader',
    },
  ]);
});
