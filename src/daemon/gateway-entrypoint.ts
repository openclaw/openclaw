import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runtimeProcessExternalPackageEntrypoints,
  runtimeProcessGatewayEntrypointNames,
} from "../infra/runtime-process-manifest.js";
import { resolveExternalPackageRuntimeEntrypointUrl } from "../infra/runtime-process-url.js";
import { pathExists } from "../utils.js";

const GATEWAY_DIST_ENTRYPOINT_BASENAMES = runtimeProcessGatewayEntrypointNames.map((name) =>
  path.basename(runtimeProcessExternalPackageEntrypoints[name]),
);

export function isGatewayDistEntrypointPath(inputPath: string): boolean {
  return /[/\\]dist[/\\].+\.(cjs|js|mjs)$/.test(inputPath);
}

export function buildGatewayInstallEntrypointCandidates(root?: string): string[] {
  if (!root) {
    return [];
  }
  return runtimeProcessGatewayEntrypointNames.map((name) =>
    fileURLToPath(resolveExternalPackageRuntimeEntrypointUrl(name, root)),
  );
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
): Promise<string | undefined> {
  return findFirstAccessibleGatewayEntrypoint(buildGatewayInstallEntrypointCandidates(root));
}
