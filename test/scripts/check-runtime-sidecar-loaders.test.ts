import { afterAll, expect, it } from "vitest";
import {
  collectTsdownEntrySources,
  findRuntimeSidecarLoaderViolations,
} from "../../scripts/check-runtime-sidecar-loaders.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";

const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());
const requirePrelude =
  'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\n';

function check(source: string, entries: string[] = []) {
  const file = "src/example/example-registry.ts";
  const ast = parser.parseSourceFile(file, source);
  return expect(findRuntimeSidecarLoaderViolations(source, file, new Set(entries), ast));
}

it("allows hidden createRequire runtime sidecars when the source is an explicit build entry", () => {
  check(`${requirePrelude}require("./example-control.runtime.js");`, [
    "src/example/example-control.runtime.ts",
  ]).toStrictEqual([]);
});

it("resolves candidate arrays used by source/build fallback loops", () => {
  check(`${requirePrelude}
    const CANDIDATES = ["./control.runtime.js", "./control.runtime.ts"] as const;
    for (const candidate of CANDIDATES) { require(candidate); }
  `).toEqual([
    {
      line: 5,
      specifier: "./control.runtime.js",
      sourcePath: "src/example/control.runtime.ts",
      reason:
        'hidden local runtime loader "./control.runtime.js" resolves to src/example/control.runtime.ts, but that source is not an explicit tsdown entry',
    },
  ]);
});

it("ignores bundler-visible dynamic imports", () => {
  check(
    'const runtimePromise: Promise<typeof import("./control.runtime.js")> = import("./control.runtime.js");',
  ).toStrictEqual([]);
});

it("collects explicit tsdown entry sources", () => {
  const entry = {
    index: "src/index.ts",
    "example-control.runtime": "src/example/example-control.runtime.ts",
  };
  expect(collectTsdownEntrySources([{ entry }])).toEqual(
    new Set(["src/index.ts", "src/example/example-control.runtime.ts"]),
  );
});
