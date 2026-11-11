import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { parse as parseAcorn } from "acorn";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { createStandaloneArtifactAdapter } from "../../scripts/lib/bun-standalone-artifacts.mjs";
import { createStandaloneParser } from "../../scripts/lib/bun-standalone-parser.mjs";
import { createStandaloneSourceParser } from "../../scripts/lib/bun-standalone-source-parser.mjs";

const runtimeRoot = "/removed-build/runtime";
const parsers = [
  { name: "Acorn", parse: createStandaloneParser(parseAcorn), typed: false },
  { name: "Babel ESTree", parse: createStandaloneSourceParser(), typed: true },
];

describe.each(parsers)("standalone artifact syntax contract: $name", ({ parse, typed }) => {
  function transform(contents: string) {
    return createStandaloneArtifactAdapter({
      runtimeRoot,
      embeddedPaths: { "dist/extensions/example/index.js": "/$bunfs/root/example.js" },
      parse,
    }).transform({ filename: `${runtimeRoot}/dist/owner.mjs`, contents });
  }

  it("delegates fingerprint identity and retains the original fallback body", () => {
    const marker = "openclaw-plugin-runtime-artifact-v1\0";
    const adapted = transform(`// π 🦞\r\nlet fallbacks = 0;
function fingerprint(record) { fallbacks++; return JSON.stringify([${JSON.stringify(marker)}, record]); }
({ fingerprint, readFallbacks: () => fallbacks });`);
    expect(adapted.count).toBe(1);
    const hook: { identity: string | undefined } = { identity: "image-identity" };
    const loaded = vm.runInNewContext(adapted.contents, {
      __openclawStandaloneFingerprintArtifact: () => hook.identity,
    });
    expect(loaded.fingerprint({ id: 7 })).toBe("image-identity");
    expect(loaded.readFallbacks()).toBe(0);
    hook.identity = undefined;
    expect(loaded.fingerprint({ id: 7 })).toBe(JSON.stringify([marker, { id: 7 }]));
    expect(loaded.readFallbacks()).toBe(1);
  });

  it("adapts the real bundled operation owner without bypassing preparation or live checks", () => {
    const source = fs.readFileSync(
      new URL("../../src/plugins/plugin-state-operation-module-loader.ts", import.meta.url),
      "utf8",
    );
    const contents = typed ? source : stripTypeScriptTypes(source);
    const ast = parse(contents, { ecmaVersion: "latest", sourceType: "module" });
    const [declaration] = ast.body.flatMap((node) =>
      node.type === "ExportNamedDeclaration" &&
      node.declaration?.type === "FunctionDeclaration" &&
      node.declaration.id?.name === "captureBundledPluginStateOperationModules"
        ? [node.declaration]
        : [],
    );
    if (!declaration || declaration.start == null || declaration.end == null) {
      throw new Error("Bundled operation capture declaration is missing");
    }
    const adapted = transform(contents.slice(declaration.start, declaration.end));
    expect(adapted.count).toBe(1);
    const captured: unknown[][] = [];
    const capture = { rootDir: "/image/dist", source: ["/image/dist/extensions/demo/op.js"] };
    const artifact = { linkHost() {} };
    const original = () => {
      throw new Error("Unexpected original capture");
    };
    let codeChanged = false;
    let assertCodeCurrent: (() => void) | undefined;
    const prepare = vm.runInNewContext(
      transformSync(`${adapted.contents}\ncaptureBundledPluginStateOperationModules;`, {
        loader: "ts",
        define: { "import.meta.url": JSON.stringify(import.meta.url) },
      }).code,
      {
        resolveBundledPluginStateOperationCapture: () => capture,
        capturePluginGenerationArtifact: original,
        preparePluginLoaderAliases: () => ({}),
        bindPluginStateOperationModuleSource: (binding: { assertCodeCurrent: () => void }) => {
          assertCodeCurrent = binding.assertCodeCurrent;
        },
        getSharedPluginCodeReloadWarning: () => codeChanged,
        __openclawStandaloneCaptureOperationArtifact: (...args: unknown[]) => {
          captured.push(args);
          return artifact;
        },
      },
    );
    const params = { rootDir: "/image/dist/extensions/demo", source: "index.js" };
    const owner = prepare(params);
    expect(captured).toEqual([[original, capture.rootDir, capture.source]]);
    owner.bind({ onModuleDispose() {} });
    expect(assertCodeCurrent).toBeTypeOf("function");
    expect(() => assertCodeCurrent!()).not.toThrow();
    codeChanged = true;
    expect(() => assertCodeCurrent!()).toThrow(
      "Bundled plugin code changed; restart the Gateway before using state operations",
    );
    captured.length = 0;
    expect(prepare({ ...params, preparedArtifact: artifact })).toBeDefined();
    expect(captured).toEqual([]);
  });

  it("admits the image plugin before running fallback counters", () => {
    const adapted =
      transform(`const counters = { calls: 0, nativeHits: 0, sourceTransformFallbacks: 0, sourceTransformForced: 0 };
function load(target) { return invoke(() => {
  counters.calls += 1;
  counters.nativeHits += 1;
  counters.sourceTransformFallbacks += 1;
  counters.sourceTransformForced += 1;
  return "fallback";
}); }
({ load, counters });`);
    expect(adapted.count).toBe(1);
    const loaded = vm.runInNewContext(adapted.contents, {
      invoke: (callback: () => unknown) => callback(),
      __openclawStandaloneLoadPluginModule: (target: string) =>
        target === "embedded" ? { moduleExport: "image" } : undefined,
    });
    expect(loaded.load("embedded")).toBe("image");
    expect(loaded.counters).toEqual({
      calls: 1,
      nativeHits: 1,
      sourceTransformFallbacks: 0,
      sourceTransformForced: 0,
    });
    expect(loaded.load("external")).toBe("fallback");
    expect(loaded.counters).toEqual({
      calls: 2,
      nativeHits: 2,
      sourceTransformFallbacks: 1,
      sourceTransformForced: 1,
    });
  });
});
