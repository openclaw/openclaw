import fs from "node:fs";
import path from "node:path";

/** Write source artifacts verbatim and JSON metadata beside them. */
export function writeFacadeFiles(dir: string, files: Record<string, string | object>): string {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(
      path.join(dir, name),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  }
  return dir;
}
