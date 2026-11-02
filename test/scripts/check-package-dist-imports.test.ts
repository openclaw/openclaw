import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectPackageDistImportErrors,
  collectPackageDistImports,
  preparePackageDistJavaScript,
} from "../../scripts/lib/package-dist-imports.mjs";
import { collectPackageRootImports } from "../../src/infra/package-root-imports.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const CHECK_SCRIPT = "scripts/check-package-dist-imports.mjs";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function packageFixture(sources: Record<string, string>) {
  const root = tempDirs.make("openclaw-package-dist-imports-");
  mkdirSync(join(root, "dist"));
  for (const [file, source] of Object.entries(sources)) {
    writeFileSync(join(root, "dist", file), source);
  }
  return root;
}

const runCheck = (args: string[]) =>
  spawnSync(process.execPath, [CHECK_SCRIPT, ...args], { encoding: "utf8" });
const emptyFiles = (files: string) =>
  Object.fromEntries(files.split(" ").map((file) => [file, ""]));

function checkImports(sources: Record<string, string>) {
  return collectPackageDistImportErrors({
    files: Object.keys(sources),
    readText: (file) => sources[file]!,
  });
}
function parseImports(source: string, file = "dist/index.js") {
  return collectPackageDistImports({ files: [file], readText: () => source });
}

describe("collectPackageDistImportErrors", () => {
  it.each([undefined, "commonjs"])(
    "resolves CommonJS files and directory entries with package type %s",
    (type) => {
      const sources: Record<string, string> = {
        "package.json": JSON.stringify({ type }),
        "index.js": "exact lib/global data native directory main-file main-directory main-missing"
          .split(" ")
          .map((specifier) => `require("./${specifier}");`)
          .join("\n"),
        ...emptyFiles(
          "exact lib/global.js data.json native.node directory/index.js " +
            "main-file/entry.js main-directory/runtime/index.js main-missing/index.js",
        ),
        "main-file/package.json": '{"main":"./entry"}',
        "main-directory/package.json": '{"main":"./runtime"}',
        "main-missing/package.json": '{"main":"./missing"}',
      };
      const check = () => checkImports(sources);

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

  it("resolves explicit CommonJS extensions and nested package boundaries", () => {
    expect(
      checkImports({
        "package.json": '{"type":"module"}',
        "index.cjs": 'function sloppy(value, value) {}\nrequire("./leaf");',
        "leaf.js": "",
        "nested/package.json": "{}",
        "nested/index.js": 'function sloppy(value, value) {}\nrequire("./leaf");',
        "nested/leaf.js": "",
      }),
    ).toEqual([]);
  });

  it.each([
    ["module", "index.js"],
    ["commonjs", "index.mjs"],
  ])("requires exact ESM paths with type %s and entry %s", (type, entry) => {
    expect(
      checkImports({
        "package.json": JSON.stringify({ type }),
        [entry]: 'import "./leaf"; export * from "./leaf"; import("./leaf");',
        "leaf.js": "",
      }),
    ).toEqual(Array.from({ length: 3 }, () => `${entry} imports missing leaf`));
  });
});

describe("collectPackageDistImports", () => {
  it("carries raw string import specifiers without adding templates, require calls, or URLs", () => {
    const specifiers: string[] = [];
    collectPackageDistImports({
      files: ["dist/index.mjs"],
      readText: () => `import "./static.mjs?rev=1";
export { value } from "../named.mjs";
export * from "./all.mjs";
import("./dynamic.mjs");
import(\`./template.mjs\`);
require("./native.cjs");
new URL("./worker.mjs", import.meta.url);`,
      onStaticImport: (specifier) => specifiers.push(specifier),
    });
    expect(specifiers).toEqual([
      "./static.mjs?rev=1",
      "../named.mjs",
      "./all.mjs",
      "./dynamic.mjs",
    ]);
  });

  it.each([
    {
      name: "static-only imports and loader names in comments",
      source:
        '// require and createRequire are only documentation.\nexport const text = "a require example";',
      literalCall: false,
      direct: false,
    },
    {
      name: "ambient require",
      source: 'require("./native.cjs");',
      literalCall: true,
      direct: true,
    },
    {
      name: "escaped require identifier",
      source: String.raw`requ\u0069re("./native.cjs");`,
      literalCall: true,
      direct: true,
    },
    {
      name: "escaped createRequire import",
      source: String.raw`import { create\u0052equire as makeLoader } from "node:module";
const load = makeLoader(import.meta.url); load("./native.cjs");`,
      literalCall: true,
      direct: false,
    },
    {
      name: "escaped createRequire property",
      source: String.raw`import * as mod from "node:module";
const load = mod["create\u0052equire"](import.meta.url); load("./native.cjs");`,
      literalCall: true,
      direct: false,
    },
    {
      name: "destructured createRequire alias",
      source: `import * as mod from "node:module";
const { createRequire: makeLoader } = mod;
const load = makeLoader(import.meta.url); load("./native.cjs");`,
      literalCall: true,
      direct: false,
    },
  ])("reports literal-call targets from parsed $name", ({ source, literalCall, direct }) => {
    const literalTargets: string[] = [];
    const imports = collectPackageDistImports({
      files: ["dist/index.mjs"],
      readText: () => `import "./static.mjs";\n${source}`,
      onLiteralCall: (specifier) => literalTargets.push(specifier),
    });
    expect(literalTargets).toEqual(literalCall ? ["./native.cjs"] : []);
    expect(imports).toEqual([
      { importerPath: "dist/index.mjs", importedPath: "dist/static.mjs" },
      ...(direct
        ? [{ importerPath: "dist/index.mjs", importedPath: "dist/native.cjs", kind: "require" }]
        : []),
    ]);
  });

  it.each(["ts", "mts", "cts"])("opts into runtime imports from typed %s helpers", (extension) => {
    const file = `dist/helper.${extension}`;
    const source =
      'import type { Missing } from "./types-only.ts";\n' +
      (extension === "cts"
        ? 'const runtime: Missing = require("./runtime.cts");'
        : 'import runtime from "./runtime.mts"; const value: Missing = runtime; new URL("./worker.ts", import.meta.url);');
    const input = { files: [file], readText: () => source };
    expect(collectPackageDistImports(input)).toEqual([]);
    const imports = collectPackageDistImports({ ...input, includeTypeScript: true });
    const expected = extension === "cts" ? ["runtime.cts"] : ["runtime.mts", "worker.ts"];
    expect(imports).toEqual(
      expected.map((target) => ({
        importerPath: file,
        importedPath: `dist/${target}`,
        ...(extension === "cts" ? { kind: "require" } : {}),
      })),
    );
    expect(collectPackageDistImportErrors({ files: [file], imports })).toEqual(
      expected.map((target) => `${file} imports missing dist/${target}`),
    );
  });

  it("normalizes typed native require aliases for package-root import analysis", () => {
    const source = `import { createRequire } from "node:module";
const load = createRequire(import.meta.url) as NodeRequire;
load("./native.cjs");`;
    expect(collectPackageRootImports(preparePackageDistJavaScript("helper.mts", source))).toContain(
      "./native.cjs",
    );
    expect(preparePackageDistJavaScript("helper.mjs", source)).toBe(source);
  });

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
        expect(() => parseImports(source, `dist/index.${extension}`)).toThrow(
          "Identifier 'package_binding_0' has already been declared",
        );
      } finally {
        observed.mockRestore();
      }
      expect(searchedSlots).toBeLessThanOrEqual(bindings * 8);
    },
  );

  it("preserves sloppy CommonJS bindings and its explicit strict directive", () => {
    const source = `function value(arg, arg) {}
var value; var value;
try {} catch (value) { var value; }
return require("./leaf.cjs");`;
    expect(parseImports(source, "dist/index.cjs")).toEqual([
      { importerPath: "dist/index.cjs", importedPath: "dist/leaf.cjs", kind: "require" },
    ]);
    expect(() => parseImports(`"use strict";\n${source}`, "dist/index.cjs")).toThrow(
      "Argument name clash",
    );
  });

  it("leaves installed dependency modules to their own package scope", () => {
    expect(
      collectPackageDistImports({
        files: [
          "node_modules/vendor/index.js",
          "dist/node_modules/vendor/index.mjs",
          "node_modules/vendor/index.ts",
        ],
        includeTypeScript: true,
        readText: () => {
          throw new Error("Dependency source belongs to a separate package scope");
        },
      }),
    ).toEqual([]);
  });

  it("collects runtime imports around JSDoc without including documentation references", () => {
    const imports = parseImports(
      `const example = \`\nimport "./phantom.js"\n\`;
/** @type {import("./type.js").Value} */
import value from "./value.js";
/** @example import "./example.js"; */
export * from "./exports.js";
export { value } from "./named.js";
/** @type {import("./malformed.js").Value< */
function load() { return import("./dynamic.js"); }
require("./common.cjs");
new URL("./worker.mjs", import.meta.url);
export { later };
const later = 1;`,
    );
    expect(imports).toEqual(
      ["value.js", "exports.js", "named.js", "dynamic.js", "common.cjs", "worker.mjs"].map(
        (name) => ({
          importerPath: "dist/index.js",
          importedPath: `dist/${name}`,
          kind: name === "common.cjs" ? "require" : undefined,
        }),
      ),
    );
  });

  it("excludes only the handoff runtime's staged native URL", () => {
    const stagedPath = "./node_modules/@openclaw/proc-safe/dist/identity.js";
    const source = `new URL("${stagedPath}", import.meta.url);
import "${stagedPath}";
export * from "${stagedPath}";
import("${stagedPath}");
require("${stagedPath}");
new URL("./node_modules/@openclaw/proc-safe/dist/other.js", import.meta.url);`;
    for (const importerPath of ["dist/managed-handoff-runtime.mjs", "dist/other.mjs"]) {
      const imports = parseImports(source, importerPath);
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

  it("limits URL dependencies without filtering ordinary relative imports", () => {
    const imports = parseImports(
      `import("./data.json");
require("../outside.cjs");
new URL("./worker.mjs?rev=1", import.meta.url);
new URL("./asset.png", import.meta.url);
new URL("../outside.cjs", import.meta.url);`,
      "package\\dist\\index.mjs",
    );
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
    const root = packageFixture({ "leaf.mjs": "export {};\n" });
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
    [["--help"], 0, "Usage: node scripts/check-package-dist-imports.mjs [package-root]"],
    [["--tag"], 1, "Unknown package dist import check option: --tag"],
    [[".", "extra"], 1, "Unexpected package dist import check argument: extra"],
    [["--", "$ROOT"], 0, "OpenClaw package dist import closure passed."],
  ] as const)("validates CLI arguments %j before scanning", (args, code, message) => {
    const root = packageFixture({ "index.js": "export {};\n" });
    const result = runCheck(args.map((arg) => (arg === "$ROOT" ? root : arg)));
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(code);
    expect(code ? result.stderr : result.stdout).toContain(message);
    if (code) {
      expect(result.stderr).not.toContain("missing dist directory");
      expect(result.stdout).not.toContain("OpenClaw package dist import closure passed.");
    } else {
      expect(result.stderr).toBe("");
    }
  });
});
