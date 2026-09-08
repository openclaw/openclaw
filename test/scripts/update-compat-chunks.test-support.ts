import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listUpdateCompatibilityChunkPaths,
  readUpdateCompatibilityInventory,
} from "../../scripts/lib/update-compat-chunks.mts";

export const previousReleaseInventory = readUpdateCompatibilityInventory(
  fileURLToPath(new URL("../../scripts/lib/update-compat-inventory.json", import.meta.url)),
);

/** A compiler-shaped candidate for the recorded release ABI, without loading a Gateway. */
export function writeUpdateCompatibilityBuildFixture(rootDir: string): void {
  const distDir = path.join(rootDir, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  const hashed = new Set(listUpdateCompatibilityChunkPaths(previousReleaseInventory));
  const symbols = new Map<string, string>();
  const lines: string[] = [];
  for (const release of previousReleaseInventory.releases) {
    for (const chunk of release.chunks) {
      const stable: string[] = [];
      for (const { exported, origin } of chunk.exports) {
        const key = `${origin.module}:${origin.symbol}`;
        let alias = symbols.get(key);
        if (!alias) {
          alias = `e${symbols.size}`;
          symbols.set(key, alias);
          lines.push(
            `//#region ${origin.module}`,
            `function ${origin.symbol}() { return ${JSON.stringify(origin.symbol)}; }`,
            `export { ${origin.symbol} as ${alias} };`,
            "//#endregion",
          );
        }
        const relative = path
          .relative(path.dirname(chunk.path), "candidate.mjs")
          .split(path.sep)
          .join("/");
        stable.push(
          `export { ${alias} as ${exported} } from ${JSON.stringify(relative.startsWith(".") ? relative : `./${relative}`)};`,
        );
      }
      if (!hashed.has(chunk.path)) {
        const destination = path.join(distDir, chunk.path);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, `${stable.join("\n")}\n`);
      }
    }
  }
  fs.writeFileSync(path.join(distDir, "candidate.mjs"), `${lines.join("\n")}\n`);
}
