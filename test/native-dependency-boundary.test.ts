import fs from "node:fs";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { getChangedPathFacts } from "../scripts/lib/changed-path-facts.mjs";
import { collectModuleReferencesFromSource } from "../scripts/lib/guard-inventory-utils.mjs";
import { createNativeTypeScriptParser } from "../scripts/lib/native-typescript.mts";
import { listGitTrackedFiles } from "../src/test-utils/repo-files.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

it("keeps first-party native capabilities out of Koffi", () => {
  const files = listGitTrackedFiles({
    repoRoot,
    pathspecs: ["src", "extensions", "packages", "scripts", "apps", "ui"],
  });
  expect(
    files,
    "The native dependency boundary requires the tracked source inventory",
  ).not.toBeNull();
  const violations = files!.flatMap((file) => {
    if (!/\.(?:[cm]?[jt]sx?)$/u.test(file) || getChangedPathFacts(file).isTestOnly) {
      return [];
    }
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    if (!source.includes("koffi")) {
      return [];
    }
    return collectModuleReferencesFromSource(parser.parseSourceFile(file, source), {
      acceptSpecifier: (specifier) => specifier === "koffi" || specifier.startsWith("koffi/"),
    }).map(({ line, specifier }) => `${file}:${line}: ${specifier}`);
  });
  expect(violations).toEqual([]);
});
