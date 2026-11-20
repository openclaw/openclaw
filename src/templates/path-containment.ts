import { relative } from "node:path";
import { isPathRelativeEscape } from "@openclaw/fs-safe/path";

export function templateContainedRelativePath(root: string, target: string): string | undefined {
  const child = relative(root, target);
  // Template file actions require a strict descendant, never the root itself.
  return child !== "" && !isPathRelativeEscape(child) ? child : undefined;
}
