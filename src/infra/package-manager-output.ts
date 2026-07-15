export function parseGlobalRootOutput(manager: "npm" | "pnpm", stdout: string): string | null {
  const root = stdout.trim();
  if (!root || root.includes("\n") || root.includes("\r")) {
    return null;
  }
  // npm >= 11 redacts UUID-like path segments to literal "***".
  return manager === "npm" && root.includes("***") ? null : root;
}
