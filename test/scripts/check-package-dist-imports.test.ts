import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectPackageDistImportErrors,
  collectPackageDistImports,
} from "../../scripts/lib/package-dist-imports.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const CHECK_SCRIPT = "scripts/check-package-dist-imports.mjs";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("collectPackageDistImportErrors", () => {
  it.each(["commonjs"])(
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
    const stagedPath = "./node_modules/@openclaw/proc-safe/dist/identity.js";
    const source = [
      `new URL("${stagedPath}", import.meta.url);`,
      `import "${stagedPath}";`,
      `export * from "${stagedPath}";`,
      `import("${stagedPath}");`,
      `require("${stagedPath}");`,
      'new URL("./node_modules/@openclaw/proc-safe/dist/other.js", import.meta.url);',
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
          importedPath: "dist/node_modules/@openclaw/proc-safe/dist/identity.js",
          kind: index === expectedNativeEdges - 1 ? "require" : undefined,
        })),
        { importerPath, importedPath: "dist/node_modules/@openclaw/proc-safe/dist/other.js" },
      ]);
    }
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
});
