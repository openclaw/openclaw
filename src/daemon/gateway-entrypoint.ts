/** Resolves gateway dist entrypoints used by installed daemon command lines. */
import path from "node:path";
import { pathExists } from "../utils.js";

const GATEWAY_DIST_ENTRYPOINT_BASENAMES = [
  "index.js",
  "index.mjs",
  "entry.js",
  "entry.mjs",
] as const;

/** Detects built gateway dist entrypoints from service command arguments. */
export function isGatewayDistEntrypointPath(inputPath: string): boolean {
  return /[/\\]dist[/\\].+\.(cjs|js|mjs)$/.test(inputPath);
}

export function buildGatewayInstallEntrypointCandidates(root?: string): string[] {
  if (!root) {
    return [];
  }
  return GATEWAY_DIST_ENTRYPOINT_BASENAMES.map((basename) => path.join(root, "dist", basename));
}

export function buildGatewayDistEntrypointCandidates(...inputs: string[]): string[] {
  const distDirs = new Set(inputs.filter(isGatewayDistEntrypointPath).map(path.dirname));

  // Prefer canonical basenames across every observed dist dir before falling
  // through, so repaired services converge on the same entrypoint order.
  return GATEWAY_DIST_ENTRYPOINT_BASENAMES.flatMap((basename) =>
    Array.from(distDirs, (distDir) => path.join(distDir, basename)),
  );
}

export async function findFirstAccessibleGatewayEntrypoint(
  candidates: string[],
  exists: (candidate: string) => Promise<boolean> = pathExists,
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export async function resolveGatewayInstallEntrypoint(
  root: string | undefined,
  exists: (candidate: string) => Promise<boolean> = pathExists,
): Promise<string | undefined> {
  return findFirstAccessibleGatewayEntrypoint(
    buildGatewayInstallEntrypointCandidates(root),
    exists,
  );
}
