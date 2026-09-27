import path from "node:path";

// Published updaters load this binding after replacing their package. Keep it
// independent of dependencies cached from the previous install in that process.
export function resolveNodeRunner(): string {
  const base = path.basename(process.execPath).trim().toLowerCase();
  return base === "node" || base === "node.exe" ? process.execPath : "node";
}
