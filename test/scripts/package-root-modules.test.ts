import fs from "node:fs";
import path from "node:path";
import { parse } from "acorn";
import { afterEach, expect, it } from "vitest";
import {
  collectPackageRootModules,
  readPackageRootImports,
} from "../../scripts/lib/package-root-modules.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const rootModules = fs.readdirSync(".").filter((file) => file.endsWith(".mjs"));

function parsedSiblingImports(file: string): string[] {
  const program = parse(fs.readFileSync(file, "utf8"), {
    ecmaVersion: "latest",
    sourceType: "module",
  });
  const found = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const { type, source } = node as { type?: string; source?: { value?: unknown } };
    const specifier = source?.value;
    if (
      (type === "ImportDeclaration" ||
        type === "ImportExpression" ||
        type === "ExportAllDeclaration" ||
        type === "ExportNamedDeclaration") &&
      typeof specifier === "string"
    ) {
      const match = /^\.\/([^/]+\.mjs)$/.exec(specifier);
      if (match) {
        found.add(match[1]!);
      }
    }
    Object.values(node).forEach(visit);
  };
  visit(program);
  return [...found].toSorted();
}

// Fixtures stage launchers through this scanner; a missed import form would drop a file.
it("scans the same sibling imports as a module parser for every package-root module", () => {
  const mismatched = rootModules.flatMap((file) => {
    const scanned = readPackageRootImports(file).toSorted();
    const parsed = parsedSiblingImports(file);
    return scanned.join() === parsed.join()
      ? []
      : [`${file}: scanned [${scanned.join(", ")}], parsed [${parsed.join(", ")}]`];
  });
  expect(mismatched).toEqual([]);
});

it("packages every sibling import of a packaged package-root module", () => {
  const { files } = JSON.parse(fs.readFileSync("package.json", "utf8")) as { files: string[] };
  const packaged = new Set(files);
  const missing = rootModules
    .filter((file) => packaged.has(file))
    .flatMap((file) =>
      readPackageRootImports(file)
        .filter((dependency) => !packaged.has(dependency))
        .map((dependency) => `${file} -> ${dependency}`),
    );
  expect(missing).toEqual([]);
});

it("closes entries over static, re-exported and dynamic sibling imports", () => {
  const root = tempDirs.make("package-root-modules-");
  const write = (file: string, source: string) => fs.writeFileSync(path.join(root, file), source);
  write(
    "entry.mjs",
    [
      'import { a } from "./static.mjs";',
      'export * from "./reexport.mjs";',
      'await import("./dynamic.mjs");',
      'await import("./dist/entry.js");',
    ].join("\n"),
  );
  write("static.mjs", 'import "./leaf.mjs";');
  for (const file of ["reexport.mjs", "dynamic.mjs", "leaf.mjs"]) {
    write(file, "export {};");
  }
  expect(collectPackageRootModules(["entry.mjs"], root)).toEqual([
    "dynamic.mjs",
    "entry.mjs",
    "leaf.mjs",
    "reexport.mjs",
    "static.mjs",
  ]);

  fs.rmSync(path.join(root, "leaf.mjs"));
  expect(() => collectPackageRootModules(["entry.mjs"], root)).toThrow(
    "static.mjs imports missing ./leaf.mjs",
  );
});
