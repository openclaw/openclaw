import fs from "node:fs";
import path from "node:path";
import { createRuntimeImportGraph } from "../../scripts/lib/runtime-import-closure.mts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const staticDependencyCache = new Map<string, readonly string[]>();

export function findSourceImportBackedges(
  entry: string | readonly string[],
  forbidden: readonly string[],
): string[] {
  const entries = typeof entry === "string" ? [entry] : entry;
  const pending = entries.map((file) => ({
    file: path.join(repoRoot, file),
    parents: [] as string[],
  }));
  const visited = new Set<string>();
  const forbiddenFiles = new Set(forbidden);
  const violations: string[] = [];
  let graph: ReturnType<typeof createRuntimeImportGraph> | undefined;
  try {
    for (const { file, parents } of pending) {
      if (visited.has(file)) {
        continue;
      }
      visited.add(file);
      const chain = [...parents, file];
      if (forbiddenFiles.has(path.relative(repoRoot, file).split(path.sep).join("/"))) {
        violations.push(chain.map((part) => path.relative(repoRoot, part)).join(" -> "));
        continue;
      }
      let dependencies = staticDependencyCache.get(file);
      if (!dependencies) {
        graph ??= createRuntimeImportGraph(repoRoot, entries, {
          includeCommonJs: true,
          sourceImports: true,
          // Vite query suffixes select asset handling without changing the source file.
          normalizeSpecifier: (specifier) => specifier.split("?", 1)[0]!,
        });
        const resolved: string[] = [];
        for (const { specifier, resolvedFileName } of graph.dependencies(file)) {
          // Browser stylesheets are assets, but misspelled paths still fail this guard.
          if (
            specifier.startsWith(".") &&
            specifier.endsWith(".css") &&
            fs
              .statSync(path.resolve(path.dirname(file), specifier), { throwIfNoEntry: false })
              ?.isFile()
          ) {
            continue;
          }
          const mapped = Object.keys(graph.compilerOptions.paths ?? {}).some((pattern) => {
            const [prefix, suffix] = pattern.split("*");
            return suffix === undefined
              ? specifier === prefix
              : specifier.startsWith(prefix!) && specifier.endsWith(suffix);
          });
          const workspacePackage =
            specifier.startsWith("@openclaw/") &&
            fs.existsSync(
              path.join(repoRoot, "packages", specifier.split("/")[1]!, "package.json"),
            );
          // Installed external packages terminate this repository-source graph.
          if (
            !specifier.startsWith(".") &&
            !path.isAbsolute(specifier) &&
            !mapped &&
            !specifier.startsWith("openclaw/") &&
            !workspacePackage
          ) {
            continue;
          }
          if (!resolvedFileName) {
            throw new Error(
              `Unresolved source import: ${path.relative(repoRoot, file)} -> ${specifier}`,
            );
          }
          if (!resolvedFileName.endsWith(".json") && !/\.d\.[cm]?ts$/.test(resolvedFileName)) {
            resolved.push(resolvedFileName);
          }
        }
        dependencies = resolved;
        staticDependencyCache.set(file, dependencies);
      }
      for (const dependency of dependencies) {
        pending.push({ file: dependency, parents: chain });
      }
    }
    return violations;
  } finally {
    graph?.close();
  }
}
