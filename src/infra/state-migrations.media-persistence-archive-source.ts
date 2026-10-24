import { readRegularFileSync } from "@openclaw/fs-safe/advanced";

export function archiveSourceMatches(
  filePath: string,
  expected: ReturnType<typeof readRegularFileSync>,
): boolean {
  try {
    const current = readRegularFileSync({ filePath });
    return (
      current.exactIdentity.dev === expected.exactIdentity.dev &&
      current.exactIdentity.ino === expected.exactIdentity.ino &&
      current.stat.mtimeMs === expected.stat.mtimeMs &&
      current.stat.size === expected.stat.size &&
      current.buffer.equals(expected.buffer)
    );
  } catch {
    return false;
  }
}
