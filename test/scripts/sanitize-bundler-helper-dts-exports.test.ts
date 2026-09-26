import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findUndeclaredBundlerHelperDtsExports,
  sanitizeBundlerHelperDtsExports,
  sanitizeBundlerHelperDtsExportTree,
} from "../../scripts/lib/sanitize-bundler-helper-dts-exports.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

describe("sanitizeBundlerHelperDtsExports", () => {
  it.each([
    { name: "literal", helper: "__exportAll" },
    { name: "escaped", helper: String.raw`\u005f_exportAll` },
  ])("flags and removes an undeclared $name helper export", ({ helper }) => {
    const source = [
      "export declare const keepMe: number;",
      `export { keepMe as km, ${helper} as ud, alsoKeep as ak };`,
      "export declare const alsoKeep: string;",
      "",
    ].join("\n");

    expect(findUndeclaredBundlerHelperDtsExports(source)).toEqual([
      { name: "__exportAll", line: 2 },
    ]);

    const sanitized = sanitizeBundlerHelperDtsExports(source);
    expect(sanitized.removed).toEqual([{ name: "__exportAll", line: 2 }]);
    expect(sanitized.sourceText).toContain("keepMe as km");
    expect(sanitized.sourceText).toContain("alsoKeep as ak");
    expect(sanitized.sourceText).not.toContain(helper);
    expect(findUndeclaredBundlerHelperDtsExports(sanitized.sourceText)).toEqual([]);
  });

  it("keeps __exportAll when the declaration file declares it", () => {
    const source = [
      "declare function __exportAll(target: object, all: object): void;",
      "export { __exportAll as ud };",
      "",
    ].join("\n");
    expect(findUndeclaredBundlerHelperDtsExports(source)).toEqual([]);
    expect(sanitizeBundlerHelperDtsExports(source).sourceText).toBe(source);
  });

  it("keeps a directly imported __exportAll binding", () => {
    const source = [
      'import { __exportAll } from "./helper.js";',
      "export { __exportAll as ud };",
      "",
    ].join("\n");
    expect(findUndeclaredBundlerHelperDtsExports(source)).toEqual([]);
    expect(sanitizeBundlerHelperDtsExports(source).sourceText).toBe(source);
  });

  it.each([
    { name: "literal", helper: "__exportAll" },
    { name: "escaped", helper: String.raw`\u005f_exportAll` },
  ])("removes generated $name helper aliases from mixed imports", ({ helper }) => {
    const source = [
      `import { keep as k, ud as ${helper} } from "./helper.js";`,
      "export { keep as k };",
      "",
    ].join("\n");
    const sanitized = sanitizeBundlerHelperDtsExports(source);
    expect(sanitized.sourceText).toContain('import { keep as k } from "./helper.js";');
    expect(sanitized.sourceText).not.toContain(helper);

    const onlyHelper = sanitizeBundlerHelperDtsExports(
      `import { ud as ${helper} } from "./helper.js";\nexport {};\n`,
    );
    expect(onlyHelper.sourceText).not.toContain(helper);
  });

  it("clears the published 2026.8.2 undeclared __exportAll export shape", () => {
    const source = readFileSync(
      new URL("../fixtures/published-2026.8.2-undeclared-exportall.d.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("__exportAll as ud");
    expect(findUndeclaredBundlerHelperDtsExports(source)).toEqual([
      { name: "__exportAll", line: 5 },
    ]);
    const sanitized = sanitizeBundlerHelperDtsExports(source);
    expect(sanitized.removed).toEqual([{ name: "__exportAll", line: 5 }]);
    expect(sanitized.sourceText).toContain("SessionDiscussionProvider as uc");
    expect(sanitized.sourceText).toContain("DispatchReplyWithDispatcher as ui");
    expect(sanitized.sourceText).not.toContain("__exportAll");
    expect(findUndeclaredBundlerHelperDtsExports(sanitized.sourceText)).toEqual([]);
  });

  it("sanitizes declaration trees emitted by direct tsdown builds", () => {
    const root = roots.make("bundler-helper-tree-");
    const nested = join(root, "plugin-sdk");
    mkdirSync(nested, { recursive: true });
    const declaration = join(nested, "chunk.d.ts");
    const runtime = join(nested, "chunk.js");
    writeFileSync(
      declaration,
      "export declare const keep: number;\nexport { keep as k, __exportAll as ud };\n",
    );
    writeFileSync(runtime, "export const keep = 1;\n");

    expect(sanitizeBundlerHelperDtsExportTree(root)).toBe(1);
    expect(readFileSync(declaration, "utf8")).not.toContain("__exportAll");
    expect(readFileSync(runtime, "utf8")).toContain("keep = 1");
    expect(sanitizeBundlerHelperDtsExportTree(root)).toBe(0);
  });
});
