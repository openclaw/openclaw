import fs from "node:fs";

export function fileFingerprint(filePath: string): unknown {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    const kind = stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "other";
    return [filePath, kind, stat.size.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString()];
  } catch {
    return [filePath, "missing"];
  }
}
