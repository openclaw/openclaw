import { describe, expect, it } from "vitest";
import {
  collectPackageDistImportErrors,
  collectPackageDistImports,
} from "../../scripts/lib/package-dist-imports.mjs";

function makeReader(files: Record<string, string>) {
  return (filePath: string) => {
    const value = files[filePath];
    if (value === undefined) {
      throw new Error(`unexpected file read: ${filePath}`);
    }
    return value;
  };
}

describe("package dist imports", () => {
  it("captures destructured static imports", () => {
    // Regression: the previous reverse-scan parser treated the closing `}` of
    // the destructured import list as a statement terminator, so the
    // specifier was silently dropped. Verify it is now detected.
    const files = {
      "dist/a.js": `import { foo } from "./missing.js";\n`,
    };
    const errors = collectPackageDistImportErrors({
      files: ["dist/a.js"],
      readText: makeReader(files),
    });
    expect(errors).toEqual(["dist/a.js imports missing dist/missing.js"]);
  });

  it("captures multi-line destructured static imports with aliases", () => {
    const files = {
      "dist/a.js": `import {\n  foo,\n  bar as renamed,\n  baz,\n} from "./missing.js";\n`,
    };
    const errors = collectPackageDistImportErrors({
      files: ["dist/a.js"],
      readText: makeReader(files),
    });
    expect(errors).toEqual(["dist/a.js imports missing dist/missing.js"]);
  });

  it("captures default + destructured imports together", () => {
    const files = {
      "dist/a.js": `import defaultExport, { named } from "./missing.js";\n`,
    };
    const errors = collectPackageDistImportErrors({
      files: ["dist/a.js"],
      readText: makeReader(files),
    });
    expect(errors).toEqual(["dist/a.js imports missing dist/missing.js"]);
  });

  it("captures namespace imports", () => {
    const files = {
      "dist/a.js": `import * as helpers from "./missing.js";\n`,
    };
    const errors = collectPackageDistImportErrors({
      files: ["dist/a.js"],
      readText: makeReader(files),
    });
    expect(errors).toEqual(["dist/a.js imports missing dist/missing.js"]);
  });

  it("captures side-effect imports", () => {
    const files = {
      "dist/a.js": `import "./missing.js";\n`,
    };
    const errors = collectPackageDistImportErrors({
      files: ["dist/a.js"],
      readText: makeReader(files),
    });
    expect(errors).toEqual(["dist/a.js imports missing dist/missing.js"]);
  });

  it("captures dynamic imports", () => {
    const files = {
      "dist/a.js": `const mod = await import("./missing.js");\n`,
    };
    const errors = collectPackageDistImportErrors({
      files: ["dist/a.js"],
      readText: makeReader(files),
    });
    expect(errors).toEqual(["dist/a.js imports missing dist/missing.js"]);
  });

  it("ignores dynamic imports with non-literal first arguments", () => {
    const files = {
      "dist/a.js": `const mod = await import(new URL("./asset.js", import.meta.url));\n`,
    };
    const errors = collectPackageDistImportErrors({
      files: ["dist/a.js"],
      readText: makeReader(files),
    });
    expect(errors).toEqual([]);
  });

  it("captures dynamic imports inside template literal interpolations", () => {
    const files = {
      "dist/a.js": 'const path = `./bundle/${await import("./missing.js")}`;\n',
    };
    const errors = collectPackageDistImportErrors({
      files: ["dist/a.js"],
      readText: makeReader(files),
    });
    expect(errors).toEqual(["dist/a.js imports missing dist/missing.js"]);
  });

  it("captures re-exports", () => {
    const files = {
      "dist/a.js": `export { foo } from "./missing-a.js";\nexport * from "./missing-b.js";\nexport * as ns from "./missing-c.js";\n`,
    };
    const errors = collectPackageDistImportErrors({
      files: ["dist/a.js"],
      readText: makeReader(files),
    });
    expect(errors.sort()).toEqual([
      "dist/a.js imports missing dist/missing-a.js",
      "dist/a.js imports missing dist/missing-b.js",
      "dist/a.js imports missing dist/missing-c.js",
    ]);
  });

  it("ignores string literals that look like specifiers but are unrelated", () => {
    const files = {
      "dist/a.js": `const NOT_AN_IMPORT = "./looks-relative.js";\nconsole.log("from ./fake.js");\nexport const message = "./also-not-imported.js";\n`,
    };
    const errors = collectPackageDistImportErrors({
      files: ["dist/a.js"],
      readText: makeReader(files),
    });
    expect(errors).toEqual([]);
  });

  it("ignores bare specifiers and absolute specifiers", () => {
    const files = {
      "dist/a.js": `import { useState } from "react";\nimport node from "node:fs";\nimport other from "/abs/path.js";\n`,
    };
    const imports = collectPackageDistImports({
      files: ["dist/a.js"],
      readText: makeReader(files),
    });
    expect(imports).toEqual([]);
  });

  it("ignores import-like text inside string literals", () => {
    const files = {
      "dist/a.js": `const sample = "import { foo } from \\"./not-real.js\\"";\nconst other = 'export * from "./also-fake.js"';\n`,
    };
    const errors = collectPackageDistImportErrors({
      files: ["dist/a.js"],
      readText: makeReader(files),
    });
    expect(errors).toEqual([]);
  });

  it("ignores import-like text inside comments", () => {
    const files = {
      "dist/a.js": `// import { foo } from "./not-real.js";\n/* import bar from "./also-fake.js"; */\nimport { real } from "./missing.js";\n`,
    };
    const errors = collectPackageDistImportErrors({
      files: ["dist/a.js"],
      readText: makeReader(files),
    });
    expect(errors).toEqual(["dist/a.js imports missing dist/missing.js"]);
  });

  it("does not confuse identifiers that contain the import keyword", () => {
    const files = {
      "dist/a.js": `const importer = doImport();\nfunction reimport(x) { return x; }\nconst exported = "value";\n`,
    };
    const errors = collectPackageDistImportErrors({
      files: ["dist/a.js"],
      readText: makeReader(files),
    });
    expect(errors).toEqual([]);
  });

  it("does not treat object property `import` as a static import", () => {
    const files = {
      "dist/a.js": `const cfg = { import: "./asset.js" };\nconst list = { import, other: 1 };\n`,
    };
    const errors = collectPackageDistImportErrors({
      files: ["dist/a.js"],
      readText: makeReader(files),
    });
    expect(errors).toEqual([]);
  });

  it("does not treat `export const X = '...'` as a specifier source", () => {
    const files = {
      "dist/a.js": `export const link = "./not-imported.js";\nexport function go() { return "./fake.js"; }\n`,
    };
    const errors = collectPackageDistImportErrors({
      files: ["dist/a.js"],
      readText: makeReader(files),
    });
    expect(errors).toEqual([]);
  });

  it("does not treat `import.meta` member access as a static import", () => {
    // `import.meta.resolve("./x")` is valid ESM and contains a relative string
    // literal, but it is a meta-property access, not an import statement.
    const files = {
      "dist/a.js":
        `const url = import.meta.resolve("./not-imported.js");\n` +
        `const base = import.meta.url;\n` +
        `console.log(import.meta.url, "./also-not-imported.js");\n`,
    };
    const errors = collectPackageDistImportErrors({
      files: ["dist/a.js"],
      readText: makeReader(files),
    });
    expect(errors).toEqual([]);
  });

  it("does not treat a `from` identifier in an export declaration as re-export", () => {
    // `from` is a contextual keyword, valid as an ordinary identifier in
    // declarations like `export const from = "./x"`. Only `from` immediately
    // following an `export *`, `export *.as.ns`, or `export { ... }` clause
    // introduces a re-export specifier.
    const files = {
      "dist/a.js":
        `export const from = "./not-imported-a.js";\n` +
        `export let from2 = "./not-imported-b.js";\n` +
        `export function makeFrom() { const from = "./not-imported-c.js"; return from; }\n`,
    };
    const errors = collectPackageDistImportErrors({
      files: ["dist/a.js"],
      readText: makeReader(files),
    });
    expect(errors).toEqual([]);
  });

  it("resolves existing files without reporting errors", () => {
    const files = {
      "dist/a.js": `import { foo } from "./b.js";\n`,
      "dist/b.js": `export const foo = 1;\n`,
    };
    const errors = collectPackageDistImportErrors({
      files: ["dist/a.js", "dist/b.js"],
      readText: makeReader(files),
    });
    expect(errors).toEqual([]);
  });

  it("handles a realistic mix of patterns in one file", () => {
    const files = {
      "dist/a.js":
        `import { r as alias } from "./present-a.js";\n` +
        `import defaultThing, { Named, Other as Alias } from "./missing-b.js";\n` +
        `import * as ns from "./missing-c.js";\n` +
        `import "./missing-d.js";\n` +
        `export { x, y } from "./missing-e.js";\n` +
        `export * as agg from "./missing-f.js";\n` +
        `const dyn = import("./missing-g.js");\n` +
        `// import { fake } from "./not-real-h.js";\n` +
        `const NOT_AN_IMPORT = "./not-imported-i.js";\n` +
        `const metaUrl = import.meta.resolve("./not-imported-j.js");\n` +
        `export const from = "./not-imported-k.js";\n`,
      "dist/present-a.js": `export const r = 1;\n`,
    };
    const errors = collectPackageDistImportErrors({
      files: Object.keys(files),
      readText: makeReader(files),
    });
    expect(errors.sort()).toEqual([
      "dist/a.js imports missing dist/missing-b.js",
      "dist/a.js imports missing dist/missing-c.js",
      "dist/a.js imports missing dist/missing-d.js",
      "dist/a.js imports missing dist/missing-e.js",
      "dist/a.js imports missing dist/missing-f.js",
      "dist/a.js imports missing dist/missing-g.js",
    ]);
  });
});
