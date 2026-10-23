import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExtensionImportBoundaryChecker } from "../../scripts/lib/extension-import-boundary-checker.mts";
import { listGeneratedExtensionAssetSources } from "../../scripts/lib/static-extension-assets.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const privateTarget = path.join(process.cwd(), "extensions/security-proof/private.js");
const relative = (from: string, to: string) => path.relative(from, to).replaceAll(path.sep, "/");
function createChecker(
  root: string,
  options: Partial<Parameters<typeof createExtensionImportBoundaryChecker>[0]> = {},
) {
  return createExtensionImportBoundaryChecker({
    boundaryLabel: "test",
    cleanMessage: "clean",
    inventoryTitle: "inventory",
    roots: [relative(process.cwd(), root)],
    ...options,
  });
}
function sample(
  name: string,
  createSource: (quoted: string) => string,
  kind = "import",
  fileName = "guarded.ts",
) {
  return { name, createSource, kind, fileName };
}

describe("extension import boundary checker", () => {
  it("rejects oversized TypeScript source files before scanning imports", async () => {
    const root = tempDirs.make("openclaw-extension-boundary-");
    const sourcePath = path.join(root, "large.ts");
    writeFileSync(sourcePath, "x".repeat(33), "utf8");
    const checker = createChecker(root, { maxSourceBytes: 32 });

    await expect(checker.collectInventory()).rejects.toThrow(
      "extension import boundary source file exceeds 32 byte limit",
    );
  });

  it("skips declared generated bundles without admitting oversized handwritten JavaScript", async () => {
    const root = tempDirs.make("openclaw-extension-boundary-");
    const pluginRoot = path.join(root, "extensions", "generated-plugin");
    const assetRoot = path.join(pluginRoot, "assets");
    const generatedPath = path.join(assetRoot, "generated.js");
    const handwrittenPath = path.join(assetRoot, "handwritten.js");
    const oversizedBytes = 2 * 1024 * 1024 + 1;
    mkdirSync(assetRoot, { recursive: true });
    writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        openclaw: {
          assetScripts: { build: "node generate.mjs" },
          build: {
            staticAssets: [{ source: "./assets/generated.js", output: "assets/generated.js" }],
          },
        },
      }),
      "utf8",
    );

    // Match CI ordering: the build materializes its declared bundle before source guards run.
    writeFileSync(generatedPath, "/".repeat(oversizedBytes), "utf8");
    const generatedSources = new Set(
      listGeneratedExtensionAssetSources({ rootDir: root }).map((source) =>
        relative(process.cwd(), path.join(root, source)),
      ),
    );
    const createAssetChecker = () =>
      createChecker(path.join(root, "extensions"), {
        shouldSkipFile: (relativeFile: string) => generatedSources.has(relativeFile),
        sourceOptions: { fileExtensions: [".js"] },
      });

    await expect(createAssetChecker().collectInventory()).resolves.toEqual([]);

    const specifier = relative(assetRoot, privateTarget);
    writeFileSync(
      handwrittenPath,
      "import " + JSON.stringify(specifier) + ";\n" + "/".repeat(oversizedBytes),
      "utf8",
    );
    await expect(createAssetChecker().collectInventory()).rejects.toThrow(
      "extension import boundary source file exceeds 2097152 byte limit",
    );
  });

  it.each([
    sample("TSX import", (q) => `import ${q}; const view = <div />;`, "import", "guarded.tsx"),
    sample("comment-obscured import", (q) => `import /* gap */ ${q}`),
    sample(
      "import attributes",
      (q) => `import /* gap */ (${q}, { with: { type: "json" } })`,
      "dynamic-import",
    ),
    sample("CommonJS require", (q) => `require(${q})`, "commonjs-require"),
    sample("import after regexp", (q) => `const pattern = /"/; import ${q}`),
    sample("require after regexp", (q) => `const pattern = /"/; require(${q})`, "commonjs-require"),
    sample("import.meta URL", (q) => `new URL(${q}, import.meta.url)`, "import-meta-url"),
    sample("escaped meta", (q) => `new URL(${q}, import.m\\u0065ta.url)`, "import-meta-url"),
    sample(
      "namespace export",
      (q) => `export /* gap */ * /* gap */ as privateModule from ${q}`,
      "export",
    ),
    sample("escaped separator", (q) => "import " + q.replace("extensions/", "extensions\\/")),
    sample("Unicode escape", (q) => "import " + q.replace("extensions/", "exten\\u0073ions/")),
    sample("hex escape", (q) => "import " + q.replace("extensions/", "\\x65xtensions/")),
    sample("line continuation", (q) => "import " + q.replace("extensions/", "exten\\\nsions/")),
  ])(
    "rejects $name crossing the real plugin boundary",
    async ({ createSource, kind, fileName }) => {
      const root = tempDirs.make("openclaw-extension-boundary-");
      const specifier = relative(root, privateTarget);
      writeFileSync(path.join(root, fileName), createSource(JSON.stringify(specifier)), "utf8");
      const checker = createChecker(root, {
        skipSourcesWithoutBundledPluginPrefix: true,
      });

      await expect(checker.collectInventory()).resolves.toEqual([
        expect.objectContaining({
          kind,
          resolvedPath: "extensions/security-proof/private.js",
          specifier,
        }),
      ]);
    },
  );

  it("excludes TSX test helpers and permits components without private plugin imports", async () => {
    const root = tempDirs.make("openclaw-extension-boundary-");
    for (const name of ["test", "test-utils", "test-harness", "e2e-harness"]) {
      writeFileSync(
        path.join(root, `ignored.${name}.tsx`),
        'import "./extensions/private/secret";',
      );
    }
    writeFileSync(path.join(root, "safe.tsx"), 'import { render } from "@solidjs/web";');
    const checker = createExtensionImportBoundaryChecker({ repoRoot: root, roots: ["."] });
    await expect(checker.collectInventory()).resolves.toEqual([]);
    const includingTests = createExtensionImportBoundaryChecker({
      repoRoot: root,
      roots: ["."],
      sourceOptions: { includeTests: true },
    });
    await expect(includingTests.collectInventory()).resolves.toHaveLength(4);
  });
});
