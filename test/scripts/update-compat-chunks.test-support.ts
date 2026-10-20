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
  const symbols = new Map<string, { alias: string; file: string }>();
  const modules = new Map<string, { file: string; lines: string[] }>();
  const stableTargets = new Map<string, Map<string, string>>();
  for (const release of previousReleaseInventory.releases) {
    for (const chunk of release.chunks) {
      const stable = stableTargets.get(chunk.path) ?? new Map<string, string>();
      for (const { exported, origin } of chunk.exports) {
        const key = `${origin.module}:${origin.symbol}`;
        let symbol = symbols.get(key);
        if (!symbol) {
          const module = modules.get(origin.module) ?? {
            file: `candidate-${modules.size}.mjs`,
            lines: [],
          };
          symbol = { alias: `e${symbols.size}`, file: module.file };
          symbols.set(key, symbol);
          module.lines.push(
            `//#region ${origin.module}`,
            `function ${origin.symbol}() { return ${JSON.stringify(origin.symbol)}; }`,
            `export { ${origin.symbol} as ${symbol.alias} };`,
            "//#endregion",
          );
          modules.set(origin.module, module);
        }
        const relative = path
          .relative(path.dirname(chunk.path), symbol.file)
          .split(path.sep)
          .join("/");
        stable.set(
          exported,
          `export { ${symbol.alias} as ${exported} } from ${JSON.stringify(relative.startsWith(".") ? relative : `./${relative}`)};`,
        );
      }
      if (!hashed.has(chunk.path)) {
        stableTargets.set(chunk.path, stable);
      }
    }
  }
  for (const [relative, exports] of stableTargets) {
    const destination = path.join(distDir, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, `${[...exports.values()].join("\n")}\n`);
  }
  for (const module of modules.values()) {
    fs.writeFileSync(path.join(distDir, module.file), `${module.lines.join("\n")}\n`);
  }
}
