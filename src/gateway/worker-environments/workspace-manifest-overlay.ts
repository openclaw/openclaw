import path from "node:path";
import { changedPaths, hasPathAncestor, manifestNodes } from "./workspace-manifest-comparison.js";
import type {
  WorkerWorkspaceManifest,
  WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";

export function applyWorkspaceSourceOverlay(
  source: WorkerWorkspaceManifest,
  prepared: WorkerWorkspaceManifest,
  incoming: WorkerWorkspaceManifest,
): WorkerWorkspaceManifest {
  const sourceNodes = manifestNodes(source);
  const incomingNodes = manifestNodes(incoming);
  const nodes = manifestNodes(prepared);
  const changed = changedPaths(source, incoming);
  const replaced = new Set(
    [...changed].filter(
      (entryPath) =>
        incomingNodes.get(entryPath)?.type !== "directory" &&
        (incomingNodes.has(entryPath) || sourceNodes.get(entryPath)?.type !== "directory"),
    ),
  );
  for (const entryPath of nodes.keys()) {
    if (changed.has(entryPath) || hasPathAncestor(replaced, entryPath)) {
      nodes.delete(entryPath);
    }
  }
  for (const entryPath of changed) {
    const entry = incomingNodes.get(entryPath);
    if (!entry) {
      continue;
    }
    nodes.set(entryPath, entry);
    // A caller child replaces a setup-created file at any required directory ancestor.
    for (
      let parent = path.posix.dirname(entryPath);
      parent !== ".";
      parent = path.posix.dirname(parent)
    ) {
      nodes.set(parent, { path: parent, type: "directory" });
    }
  }
  // Removing the last pristine child does not remove setup-only siblings or their parents.
  for (const entryPath of nodes.keys()) {
    for (
      let parent = path.posix.dirname(entryPath);
      parent !== ".";
      parent = path.posix.dirname(parent)
    ) {
      if (!nodes.has(parent)) {
        nodes.set(parent, { path: parent, type: "directory" });
      }
    }
  }
  return {
    version: 1,
    baseCommit: incoming.baseCommit,
    entries: [...nodes.values()].filter(
      (entry): entry is WorkerWorkspaceManifestEntry =>
        entry?.type === "file" || entry?.type === "symlink",
    ),
    directories: [...nodes.values()].flatMap((entry) =>
      entry?.type === "directory" ? [entry.path] : [],
    ),
  };
}
