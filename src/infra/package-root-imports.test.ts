import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";

it("scans repeated opaque call arguments without losing package imports", () => {
  const source = [
    'import "static-package";',
    'throw new Error("This source must never execute");',
    "function opaque() {}",
    "const value0 = opaque();",
    ...Array.from({ length: 26 }, (_, index) => {
      const call = index % 2 === 0 ? "opaque" : "opaque?.";
      return `const value${index + 1} = ${call}(value${index}, value${index});`;
    }),
    "const require = opaque(value26);",
    'require("runtime-package");',
    'import("dynamic-package");',
  ].join("\n");
  const scanner = pathToFileURL(resolve("src/infra/package-root-imports.ts")).href;
  // A child deadline contains CPU regressions that block an in-process test timeout.
  const result = spawnNodeEvalSync(
    `import { readFileSync } from "node:fs";
     import { collectPackageRootImports } from ${JSON.stringify(scanner)};
     process.stdout.write(JSON.stringify(collectPackageRootImports(readFileSync(0, "utf8"))));`,
    { input: source, timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 },
  );

  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).toSorted()).toEqual([
    "dynamic-package",
    "runtime-package",
    "static-package",
  ]);
});
