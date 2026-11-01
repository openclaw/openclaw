import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { vitestWorkerRuntimeAssets } from "../../scripts/lib/vitest-worker-declarations.mts";

// Workers copy only the listed package-root modules; an unlisted sibling import fails at load.
it("stages every relative import of the package-root worker runtime assets", () => {
  const listed = new Set<string>(vitestWorkerRuntimeAssets);
  const missing: string[] = [];
  for (const asset of vitestWorkerRuntimeAssets) {
    const source = fs.readFileSync(path.resolve(asset), "utf8");
    for (const match of source.matchAll(/from "\.\/([^"/]+\.mjs)"/g)) {
      const specifier = match[1];
      if (specifier && !listed.has(specifier)) {
        missing.push(`${asset} -> ${specifier}`);
      }
    }
  }
  expect(missing).toEqual([]);
});
