import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let precomputedRootHelpText: string | null | undefined;

export function loadPrecomputedRootHelpText(): string | null {
  if (precomputedRootHelpText !== undefined) {
    return precomputedRootHelpText;
  }
  try {
    const metadataPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "cli-startup-metadata.json",
    );
    const raw = fs.readFileSync(metadataPath, "utf8");
    const parsed = JSON.parse(raw) as { rootHelpText?: unknown };
    if (typeof parsed.rootHelpText === "string" && parsed.rootHelpText.length > 0) {
      precomputedRootHelpText = parsed.rootHelpText;
      return precomputedRootHelpText;
    }
  } catch {
    // Fall back to live root-help rendering.
  }
  precomputedRootHelpText = null;
  return null;
}

export function outputPrecomputedRootHelpText(): boolean {
  const rootHelpText = loadPrecomputedRootHelpText();
  if (!rootHelpText) {
    return false;
  }
  process.stdout.write(rootHelpText);
  return true;
}

export const __testing = {
  resetPrecomputedRootHelpTextForTests(): void {
    precomputedRootHelpText = undefined;
  },
};
