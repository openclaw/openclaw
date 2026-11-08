/** Path containment helpers re-exported for security scanners. */
export { isPathInside, isPathInsideWithRealpath } from "@openclaw/fs-safe/path";

/** Return true for extension paths intentionally skipped by source scanners. */
export function extensionUsesSkippedScannerPath(entry: string): boolean {
  const segments = entry.split(/[\\/]+/).filter(Boolean);
  return segments.some(
    (segment) =>
      segment === "node_modules" ||
      (segment.startsWith(".") && segment !== "." && segment !== ".."),
  );
}
