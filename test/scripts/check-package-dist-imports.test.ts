import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectPackageDistImportErrors,
  collectPackageDistImports,
} from "../../scripts/lib/package-dist-imports.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const CHECK_SCRIPT = "scripts/check-package-dist-imports.mjs";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function checkPackage(
  sources: Record<string, string>,
  args: (root: string) => string[] = (root) => [root],
) {
  const root = tempDirs.make("openclaw-package-dist-imports-");
  mkdirSync(join(root, "dist"));
  for (const [file, source] of Object.entries(sources)) {
    writeFileSync(join(root, "dist", file), source);
  }
  return spawnSync(process.execPath, [CHECK_SCRIPT, ...args(root)], { encoding: "utf8" });
}

describe("collectPackageDistImportErrors", () => {
  it.each([undefined, "commonjs"])(
    "resolves CommonJS files and directory entries with package type %s",
    (type) => {
      const sources: Record<string, string> = {
        "package.json": JSON.stringify({ type }),
        "index.js": [
          "./exact",
          "./lib/global",
          "./data",
          "./native",
          "./directory",
          "./main-file",
          "./main-directory",
          "./main-missing",
        ]
          .map((specifier) => `require(${JSON.stringify(specifier)});`)
          .join("\n"),
        exact: "module.exports = true;",
        "lib/global.js": "module.exports = true;",
        "data.json": '{"value":true}',
        "native.node": "",
        "directory/index.js": "module.exports = true;",
        "main-file/package.json": '{"main":"./entry"}',
        "main-file/entry.js": "module.exports = true;",
        "main-directory/package.json": '{"main":"./runtime"}',
        "main-directory/runtime/index.js": "module.exports = true;",
        "main-missing/package.json": '{"main":"./missing"}',
        "main-missing/index.js": "module.exports = true;",
      };
      const check = () =>
        collectPackageDistImportErrors({
          files: Object.keys(sources),
          readText: (file) => sources[file]!,
        });

      expect(check()).toEqual([]);
      delete sources["lib/global.js"];
      expect(check()).toEqual(["index.js imports missing lib/global"]);
      sources["index.js"] = 'import("./data"); require("./data?rev=1");';
      expect(check()).toEqual([
        "index.js imports missing data",
        "index.js imports missing data?rev=1",
      ]);
    },
  );

  it.each<{ name: string; sources: Record<string, string>; errors: string[] }>([
    {
      name: "explicit CommonJS extensions and nested package boundaries",
      sources: {
        "package.json": '{"type":"module"}',
        "index.cjs": 'function sloppy(value, value) {}\nrequire("./leaf");',
        "leaf.js": "export {};",
        "nested/package.json": "{}",
        "nested/index.js": 'function sloppy(value, value) {}\nrequire("./leaf");',
        "nested/leaf.js": "module.exports = true;",
      },
      errors: [],
    },
    ...[
      { type: "module", entry: "index.js" },
      { type: "commonjs", entry: "index.mjs" },
    ].map(({ type, entry }) => ({
      name: `${entry} ESM paths with package type ${type}`,
      sources: {
        "package.json": JSON.stringify({ type }),
        [entry]: 'import "./leaf"; export * from "./leaf"; import("./leaf");',
        "leaf.js": "",
      },
      errors: Array.from({ length: 3 }, () => `${entry} imports missing leaf`),
    })),
  ])("resolves $name", ({ sources, errors }) => {
    expect(
      collectPackageDistImportErrors({
        files: Object.keys(sources),
        readText: (file) => sources[file]!,
      }),
    ).toEqual(errors);
  });
});

describe("collectPackageDistImports", () => {
  it.each(["mjs", "cjs"])(
    "keeps binding searches bounded while rejecting a redeclaration in a large %s artifact",
    (extension) => {
      const bindings = 2048;
      const source =
        Array.from(
          { length: bindings },
          (_, index) => `const package_binding_${index} = ${index};`,
        ).join("\n") + "\nlet package_binding_0;";
      let searchedSlots = 0;
      const indexOf = Array.prototype.indexOf;
      const observed = vi.spyOn(Array.prototype, "indexOf").mockImplementation(function (
        this: unknown[],
        value: unknown,
        fromIndex?: number,
      ) {
        if (typeof value === "string" && value.startsWith("package_binding_")) {
          searchedSlots += this.length;
        }
        return indexOf.call(this, value, fromIndex);
      });
      try {
        expect(() =>
          collectPackageDistImports({
            files: [`dist/index.${extension}`],
            readText: () => source,
          }),
        ).toThrow("Identifier 'package_binding_0' has already been declared");
      } finally {
        observed.mockRestore();
      }
      expect(searchedSlots).toBeLessThanOrEqual(bindings * 8);
    },
  );

  it("preserves sloppy CommonJS bindings and its explicit strict directive", () => {
    const source = [
      "function value(arg, arg) {}",
      "var value; var value;",
      "try {} catch (value) { var value; }",
      'return require("./leaf.cjs");',
    ].join("\n");
    expect(
      collectPackageDistImports({ files: ["dist/index.cjs"], readText: () => source }),
    ).toEqual([{ importerPath: "dist/index.cjs", importedPath: "dist/leaf.cjs", kind: "require" }]);
    expect(() =>
      collectPackageDistImports({
        files: ["dist/index.cjs"],
        readText: () => `"use strict";\n${source}`,
      }),
    ).toThrow("Argument name clash");
  });

  it("leaves installed dependency modules to their own package scope", () => {
    expect(
      collectPackageDistImports({
        files: ["node_modules/vendor/index.js", "dist/node_modules/vendor/index.mjs"],
        readText: () => {
          throw new Error("Dependency source belongs to a separate package scope");
        },
      }),
    ).toEqual([]);
  });

  it("collects runtime imports around JSDoc without including documentation references", () => {
    const imports = collectPackageDistImports({
      files: ["dist/index.js"],
      readText: () =>
        [
          'const example = `\nimport "./phantom.js"\n`;',
          '/** @type {import("./type.js").Value} */',
          'import value from "./value.js";',
          '/** @example import "./example.js"; */',
          'export * from "./exports.js";',
          '/** @type {import("./malformed.js").Value< */',
          'function load() { return import("./dynamic.js"); }',
          'require("./common.cjs");',
          'new URL("./worker.mjs", import.meta.url);',
          "export { later }; const later = 1;",
        ].join("\n"),
    });
    expect(imports).toEqual(
      ["value.js", "exports.js", "dynamic.js", "common.cjs", "worker.mjs"].map((name) => ({
        importerPath: "dist/index.js",
        importedPath: `dist/${name}`,
        kind: name === "common.cjs" ? "require" : undefined,
      })),
    );
  });

  it("excludes only the handoff runtime's staged native URL", () => {
    const stagedPath = "./node_modules/koffi/indirect.cjs";
    const source = [
      `new URL("${stagedPath}", import.meta.url);`,
      `import "${stagedPath}";`,
      `export * from "${stagedPath}";`,
      `import("${stagedPath}");`,
      `require("${stagedPath}");`,
      'new URL("./node_modules/koffi/other.cjs", import.meta.url);',
    ].join("\n");
    for (const importerPath of ["dist/managed-handoff-runtime.mjs", "dist/other.mjs"]) {
      const imports = collectPackageDistImports({
        files: [importerPath],
        readText: () => source,
      });
      const expectedNativeEdges = importerPath === "dist/managed-handoff-runtime.mjs" ? 4 : 5;
      expect(imports).toEqual([
        ...Array.from({ length: expectedNativeEdges }, (_, index) => ({
          importerPath,
          importedPath: "dist/node_modules/koffi/indirect.cjs",
          kind: index === expectedNativeEdges - 1 ? "require" : undefined,
        })),
        { importerPath, importedPath: "dist/node_modules/koffi/other.cjs" },
      ]);
    }
  });

  it("limits URL dependencies without filtering ordinary relative imports", () => {
    const imports = collectPackageDistImports({
      files: ["package\\dist\\index.mjs"],
      readText: () =>
        [
          'import("./data.json");',
          'require("../outside.cjs");',
          'new URL("./worker.mjs?rev=1", import.meta.url);',
          'new URL("./asset.png", import.meta.url);',
          'new URL("../outside.cjs", import.meta.url);',
        ].join("\n"),
    });
    expect(imports).toEqual(
      ["dist/data.json", "outside.cjs", "dist/worker.mjs"].map((importedPath) => ({
        importerPath: "dist/index.mjs",
        importedPath,
        kind: importedPath === "outside.cjs" ? "require" : undefined,
      })),
    );
  });
});

describe("check-package-dist-imports", () => {
  it("checks large bundles in a bounded heap and still rejects missing trailing imports", () => {
    const root = tempDirs.make("openclaw-package-dist-imports-large-");
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "leaf.mjs"), "export {};\n");
    const source = 'import "./leaf.mjs";\n' + "void 0;\n".repeat(400_000);

    for (const target of ["leaf.mjs", "missing.mjs"]) {
      writeFileSync(join(root, "dist", "index.mjs"), `${source}export * from "./${target}";\n`);
      const result = spawnSync(process.execPath, ["--max-old-space-size=48", CHECK_SCRIPT, root], {
        encoding: "utf8",
      });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.signal, result.stderr).toBeNull();
      if (target === "leaf.mjs") {
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("OpenClaw package dist import closure passed.");
      } else {
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("dist/index.mjs imports missing dist/missing.mjs");
      }
    }
  });

  it.each([
    {
      args: ["--help"],
      code: 0,
      output: "Usage: node scripts/check-package-dist-imports.mjs [package-root]",
    },
    { args: ["--tag"], code: 1, error: "Unknown package dist import check option: --tag" },
    {
      args: [".", "extra"],
      code: 1,
      error: "Unexpected package dist import check argument: extra",
    },
    { args: ["--", "$ROOT"], code: 0, output: "OpenClaw package dist import closure passed." },
    { args: ["$ROOT", ""], code: 1, error: "Unexpected package dist import check argument" },
  ])("validates CLI arguments $args before scanning", ({ args, code, output, error }) => {
    const result = checkPackage({ "index.js": "export {};\n" }, (root) =>
      args.map((arg) => (arg === "$ROOT" ? root : arg)),
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(code);
    if (output) {
      expect(result.stdout).toContain(output);
    }
    if (error) {
      expect(result.stderr).toContain(error);
      expect(result.stderr).not.toContain("missing dist directory");
      expect(result.stdout).not.toContain("OpenClaw package dist import closure passed.");
    } else {
      expect(result.stderr).toBe("");
    }
  });

  it("rejects missing chunks across ESM import, re-export, and CommonJS forms", () => {
    const sources = {
      "named-import.js": 'import { value } from "./missing.js";\n',
      "multiline-import.js": 'import {\n  value,\n} from "./missing.js";\n',
      "named-export.js": 'export { value } from "./missing.js";\n',
      "multiline-export.js": 'export {\n  value,\n} from "./missing.js";\n',
      "index.cjs": 'module.exports = require("./chunk.cjs");\n',
      "return.cjs": 'var await = require("./chunk.cjs"); return await;\n',
    };
    const result = checkPackage(sources);

    expect(result.status).not.toBe(0);
    for (const file of Object.keys(sources)) {
      const target = file.endsWith(".cjs") ? "chunk.cjs" : "missing.js";
      expect(result.stderr).toContain(`dist/${file} imports missing dist/${target}`);
    }
  });

  it("ignores import.meta.url probes outside packaged dist", () => {
    const root = tempDirs.make("openclaw-package-dist-imports-");
    mkdirSync(join(root, "dist"), { recursive: true });
    const probes = [
      "../../openclaw.mjs",
      "../../scripts/run-node.mjs",
      "../../dist/entry.js",
      "../../dist/entry.mjs",
    ];
    writeFileSync(
      join(root, "dist", "index.js"),
      probes
        .map(
          (specifier, index) =>
            `const candidate${index} = new URL(${JSON.stringify(specifier)}, import.meta.url);`,
        )
        .join("\n"),
      "utf8",
    );

    const result = spawnSync("node", [CHECK_SCRIPT, root], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("OpenClaw package dist import closure passed.");
  });
});
