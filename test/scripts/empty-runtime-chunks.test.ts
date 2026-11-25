import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { build } from "tsdown";
import { expect, it } from "vitest";
import { createEmptyRuntimeChunksPlugin } from "../../scripts/lib/empty-runtime-chunks.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

it("removes empty barrel companions while preserving public and dynamic modules in an async graph", async () => {
  const root = createTempDir("openclaw-empty-runtime-chunks-");
  const sources = {
    "package.json": '{"type":"module"}',
    "a.ts": "export function a() { return 42; }",
    "b.ts": "export function b() { return 7; }",
    "barrel.ts": 'export { a } from "./a.js"; export { b } from "./b.js";',
    "consumer.ts": 'import { a, b } from "./barrel.js"; export const value = a() + b();',
    "other.ts": 'import { a } from "./a.js"; export const value = a();',
    "async.ts": [
      'import { b } from "./b.js";',
      'import "./effect.js";',
      "await Promise.resolve();",
      "export const value = b();",
      'export const load = () => import("./lazy.js");',
    ].join("\n"),
    "effect.ts": 'globalThis[Symbol.for("empty-chunk-effect")] = 1;',
    "empty.ts": "export {};",
    "lazy.ts": "export {};",
  };
  for (const [name, source] of Object.entries(sources)) {
    fs.writeFileSync(path.join(root, name), source);
  }
  const { bundles } = await build({
    config: false,
    cwd: root,
    entry: {
      "sdk/barrel": "barrel.ts",
      "sdk/empty": "empty.ts",
      consumer: "consumer.ts",
      other: "other.ts",
      async: "async.ts",
    },
    outDir: "dist",
    dts: false,
    target: "node22",
    fixedExtension: false,
    outExtensions: () => ({ js: ".js" }),
    minify: { codegen: true, compress: false, mangle: { toplevel: false, keepNames: true } },
    outputOptions: { chunkFileNames: "[name]-[hash].mjs" },
    plugins: [createEmptyRuntimeChunksPlugin()],
    logLevel: "silent",
  });
  try {
    const chunks = bundles.flatMap((bundle) => bundle.chunks);
    expect(
      chunks.filter(
        (chunk) =>
          chunk.type === "chunk" &&
          !chunk.isEntry &&
          !chunk.isDynamicEntry &&
          chunk.code.trim() === "export{};",
      ),
    ).toEqual([]);
    const result = execFileSync(
      resolveTestNodeExecPath(),
      [
        "--input-type=module",
        "-e",
        [
          'import * as api from "./dist/sdk/barrel.js";',
          'import * as empty from "./dist/sdk/empty.js";',
          'import { value, load } from "./dist/async.js";',
          "console.log(JSON.stringify({",
          "keys: Object.keys(api), values: [api.a(), api.b(), value],",
          "empty: Object.keys(empty), lazy: Object.keys(await load()),",
          'effect: globalThis[Symbol.for("empty-chunk-effect")]',
          "}));",
        ].join("\n"),
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(JSON.parse(result)).toEqual({
      keys: ["a", "b"],
      values: [42, 7, 7],
      empty: [],
      lazy: [],
      effect: 1,
    });
  } finally {
    for (const bundle of bundles) {
      await bundle[Symbol.asyncDispose]();
    }
  }
});
