import path from "node:path";
import type { Root } from "@openclaw/fs-safe/root";
import type { WatchScope } from "@openclaw/fs-safe/watch";
import { admitObservationRoot, observationPrefixKind } from "../../infra/fs-observation-root.js";
import type { WatchTarget } from "./refresh-watch-targets.js";

/** Admit once per logical source owner; backend retries reuse the exact Root. */
export async function admitSkillsObservationRoot(target: WatchTarget): Promise<Root> {
  return await admitObservationRoot(target.authorityPath);
}

/** Observe a blocking link entry, never an implicit recursive target admission. */
export async function skillsObservationScope(
  authority: Root,
  target: WatchTarget,
  signal: AbortSignal,
): Promise<WatchScope> {
  const relative = path.relative(authority.rootDir, target.path);
  const parts = relative.split(path.sep).filter(Boolean);
  let parent = ".";
  for (const part of parts) {
    signal.throwIfAborted();
    parent = path.join(parent, part);
    const kind = await observationPrefixKind(authority, parent, signal);
    if (kind === "missing") {
      break;
    }
    if (kind !== "directory") {
      return { path: parent, kind: "entry" };
    }
  }
  // Tree depth counts entries, not registered directories. Source-origin
  // metadata is two entries below the deepest admitted skill directory.
  return { path: relative || ".", kind: "tree", depth: target.depth + 2 };
}
