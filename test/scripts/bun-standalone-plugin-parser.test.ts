import fs from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { moduleResolve } from "import-meta-resolve";
import { afterEach, expect, it } from "vitest";
import { rewriteStandaloneImports } from "../../scripts/lib/bun-standalone-imports.mjs";
import { createStandaloneNativeAdapter } from "../../scripts/lib/bun-standalone-native.mjs";
import { createStandaloneRequireAdapter } from "../../scripts/lib/bun-standalone-require.mjs";
import { createStandaloneSourceParser } from "../../scripts/lib/bun-standalone-source-parser.mjs";
import { runStandaloneBootstrap } from "../helpers/standalone-bootstrap.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { writeFixtureFiles } from "./z0632-fixtures.test-support.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

it.each(["literal", "template"])(
  "parses plugin references with an embedded %s parser target and its source package removed",
  (spelling) => {
    const root = temporary.make("standalone-plugin-parser-");
    const image = temporary.make("standalone-parser-image-");
    const imageEntry = path.join(image, "acorn.mjs");
    const esmSource = fs.readFileSync(
      moduleResolve("acorn", new URL(import.meta.url), new Set(["node", "import"])),
      "utf8",
    );
    fs.writeFileSync(imageEntry, esmSource);
    const filename = path.join(root, "dist/parser.js");
    let source = stripTypeScriptTypes(
      fs.readFileSync(
        new URL("../../src/plugins/plugin-source-references.ts", import.meta.url),
        "utf8",
      ),
      { mode: "strip" },
    );
    if (spelling === "template") {
      source = source.replace(
        'moduleResolve("acorn", new URL(import.meta.url), new Set(["node", "import"]))',
        "moduleResolve(`acorn`, new URL(import.meta.url), new Set([`node`, `import`]))",
      );
    }
    writeFixtureFiles(root, {
      "package.json": JSON.stringify({
        name: "openclaw",
        type: "module",
        dependencies: { acorn: "1.0.0" },
      }),
      "dist/parser.js": source,
      "node_modules/acorn/package.json": JSON.stringify({
        name: "acorn",
        version: "1.0.0",
        exports: { import: "./index.mjs", require: "./index.cjs" },
      }),
      "node_modules/acorn/index.mjs": esmSource,
      "node_modules/acorn/index.cjs": "throw new Error('The ESM parser target must be preserved');",
    });
    const parse = createStandaloneSourceParser();
    const native = createStandaloneNativeAdapter({ runtimeRoot: root, parse });
    const admitted = native.discover(["dist/parser.js"]);
    const embeddedPaths: Record<string, string> = {};
    if (admitted.includes("node_modules/acorn/index.mjs")) {
      embeddedPaths["node_modules/acorn/index.mjs"] = imageEntry;
    }
    const transformed = native.transform({ filename, contents: source });
    const finalized = native.finalize({ embeddedPaths });
    const requires = createStandaloneRequireAdapter({ runtimeRoot: root, embeddedPaths });
    const context = vm.createContext({
      root,
      path,
      fileURLToPath,
      pathToFileURL,
      createRequire,
      moduleResolve,
      URL,
      markPluginSourceAcquisitionError: (error: unknown) => error,
      __openclawStandaloneRootUrl: pathToFileURL(root + path.sep).href,
      commonJsEntries: new Set(),
      embedded: (value: string) =>
        value === imageEntry ? imageEntry : embeddedPaths[path.relative(root, value)],
    });
    vm.runInContext(
      native.bootstrap
        .replace(/^import[^\n]+\n/, "")
        .replace(finalized.bootstrapReplacement.search, finalized.bootstrapReplacement.replacement),
      context,
    );
    runStandaloneBootstrap(requires.bootstrap, context);
    const rewritten = rewriteStandaloneImports({
      contents: transformed.contents,
      filename,
      runtimeRoot: root,
      embeddedPaths,
      moduleAliases: {},
      workerThreadsShim: "/unused-worker-shim.cjs",
      parse,
    });
    const ast = parse(rewritten, {
      ecmaVersion: "latest",
      sourceType: "module",
    }) as import("acorn").Program;
    const edits = ast.body.flatMap<[number, number]>((node) =>
      node.type === "ImportDeclaration"
        ? [[node.start, node.end]]
        : node.type === "ExportNamedDeclaration" && node.declaration
          ? [[node.start, node.declaration.start]]
          : [],
    );
    let script = rewritten;
    for (const [start, end] of edits.toSorted((a, b) => b[0] - a[0])) {
      script = script.slice(0, start) + script.slice(end);
    }
    fs.rmSync(path.join(root, "node_modules"), { recursive: true });
    vm.runInContext(script, context);
    const references: string[] = [];
    context.visitPluginSourceReferences(
      "/plugin/index.mjs",
      "import './dependency.mjs';",
      () => {
        throw new Error("Native JavaScript does not need transformation");
      },
      (reference: string) => references.push(reference),
    );
    expect(references).toEqual(["./dependency.mjs"]);
  },
);
