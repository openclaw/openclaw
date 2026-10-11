import path from "node:path";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";

export function canonicalEntryPath(value: string): string {
  const absolute = path.resolve(value);
  return path.join(
    resolvePathViaExistingAncestorSync(path.dirname(absolute)),
    path.basename(absolute),
  );
}
