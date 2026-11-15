import path from "node:path";

// Resolve the runtime for OpenClaw CLI child commands. Published updaters load
// this after replacing their package, so keep it independent of package dependencies.
export function resolveNodeRunner(): string {
  const base = path.basename(process.execPath).trim().toLowerCase();
  return process.versions.bun || base === "node" || base === "node.exe" ? process.execPath : "node";
}
