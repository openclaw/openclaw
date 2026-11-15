import fs from "node:fs";
import path from "node:path";

/** Read the nearest package type for native ESM retention decisions. */
export function isNativeEsmPackage(source: string): boolean {
  let directory = path.dirname(source);
  while (true) {
    const manifest = path.join(directory, "package.json");
    if (fs.existsSync(manifest)) {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(manifest, "utf8"));
        return (
          typeof parsed === "object" &&
          parsed !== null &&
          Object.getOwnPropertyDescriptor(parsed, "type")?.value === "module"
        );
      } catch {
        return false;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return false;
    }
    directory = parent;
  }
}
