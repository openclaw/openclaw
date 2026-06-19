import type { FsRoot, FsRootKind } from "../config/types.tools.js";

export type LocalMediaRoot = string | FsRoot;

export function resolveLocalMediaRoot(root: LocalMediaRoot): {
  path: string;
  kind: FsRootKind;
} {
  if (typeof root === "string") {
    return { path: root, kind: "dir" };
  }
  return { path: root.path, kind: root.kind };
}

export function resolveLocalMediaRootPath(root: LocalMediaRoot): string {
  return typeof root === "string" ? root : root.path;
}
