import { relative } from "node:path";
import { isPathRelativeEscape } from "@openclaw/fs-safe/path";

export function clawContainedRelativePath(root: string, target: string): string | undefined {
  const child = relative(root, target);
  // Claw file actions require a strict descendant, never the root itself.
  return child !== "" && !isPathRelativeEscape(child) ? child : undefined;
}
