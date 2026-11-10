import path from "node:path";
import type { AllowAlwaysPattern } from "./exec-approvals.types.js";
import { resolveExecutableTrustPath } from "./exec-command-resolution.js";

export function addAllowAlwaysPattern(
  out: AllowAlwaysPattern[],
  pattern: string,
  argPattern?: string,
): void {
  const exists = out.some(
    (p) => p.pattern === pattern && (p.argPattern ?? undefined) === (argPattern ?? undefined),
  );
  if (!exists) {
    out.push({ pattern, argPattern });
  }
}

export function resolveCandidateTrustPath(candidatePath: string | undefined): string | undefined {
  if (!candidatePath) {
    return undefined;
  }
  return resolveExecutableTrustPath({
    kind: "executable",
    rawExecutable: candidatePath,
    resolvedPath: candidatePath,
    executableName: path.basename(candidatePath),
  });
}
