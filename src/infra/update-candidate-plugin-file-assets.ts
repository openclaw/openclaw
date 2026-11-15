import path from "node:path";
import { isPathInside } from "./path-guards.js";
import type {
  UpdateCandidatePluginEntry,
  UpdateCandidatePluginTreePlan,
} from "./update-candidate-plugin-tree-schema.js";
import { createRuntimePathLookup } from "./update-runtime-path-index.js";
import { resolveRuntimeFileRelocator } from "./update-runtime-relocation.js";

// Path suffixes and mode bound this projection, not file contents. Recognized
// code/native suffixes and relocation-owned files retain their representation.
const dataExtensions = new Set([
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".csv",
  ".xml",
]);
export function selectUpdateCandidatePluginFileAssets(
  plan: Pick<UpdateCandidatePluginTreePlan, "entries" | "edges">,
) {
  const files = new Map(
    plan.entries.filter((entry) => entry.kind === "file").map((entry) => [entry.path, entry]),
  );
  // Only regular inventoried manifests establish scope; symlink manifests do not.
  const packages = createRuntimePathLookup(
    [...files.keys()]
      .filter((file) => path.basename(file) === "package.json")
      .toSorted((left, right) => right.length - left.length)
      .map((file) => [path.dirname(file), path.dirname(file)] as const),
  );
  const edges = new Map(plan.edges.map((edge) => [edge.source, edge.real]));
  const assets = new Map<string, Extract<UpdateCandidatePluginEntry, { kind: "file" }>>();
  for (const entry of plan.entries) {
    if (entry.kind !== "symlink" || !dataExtensions.has(path.extname(entry.path))) {
      continue;
    }
    const target = files.get(edges.get(entry.path) ?? "");
    const owner = packages(entry.path);
    if (
      !target ||
      !owner ||
      isPathInside(owner, target.path) ||
      target.mode & 0o111 ||
      !dataExtensions.has(path.extname(target.path)) ||
      resolveRuntimeFileRelocator(entry.path) ||
      resolveRuntimeFileRelocator(target.path)
    ) {
      continue;
    }
    // package.json establishes resolver scope and must never become an incidental asset.
    if (
      path.basename(entry.path) === "package.json" ||
      path.basename(target.path) === "package.json"
    ) {
      continue;
    }
    assets.set(entry.path, target);
  }
  return assets;
}
