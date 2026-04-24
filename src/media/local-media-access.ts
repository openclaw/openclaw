import fs from "node:fs/promises";
import path from "node:path";
import { assertNoWindowsNetworkPath } from "../infra/local-file-access.js";
import { getDefaultMediaLocalRoots } from "./local-roots.js";

export type LocalMediaAccessErrorCode =
  | "path-not-allowed"
  | "invalid-root"
  | "invalid-file-url"
  | "network-path-not-allowed"
  | "unsafe-bypass"
  | "not-found"
  | "invalid-path"
  | "not-file";

export class LocalMediaAccessError extends Error {
  code: LocalMediaAccessErrorCode;

  constructor(code: LocalMediaAccessErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "LocalMediaAccessError";
  }
}

export function getDefaultLocalRoots(): readonly string[] {
  return getDefaultMediaLocalRoots();
}

async function resolvePathVariants(targetPath: string): Promise<string[]> {
  const variants = new Set<string>();
  variants.add(path.resolve(targetPath));
  try {
    variants.add(await fs.realpath(targetPath));
  } catch {
    // Keep the unresolved absolute path so callers can still validate paths
    // that live under symlinked roots such as /tmp on macOS.
  }
  return Array.from(variants);
}

function isPathWithinRoot(targetPath: string, rootPath: string): boolean {
  return targetPath === rootPath || targetPath.startsWith(rootPath + path.sep);
}

export async function assertLocalMediaAllowed(
  mediaPath: string,
  localRoots: readonly string[] | "any" | undefined,
): Promise<void> {
  if (localRoots === "any") {
    return;
  }
  try {
    assertNoWindowsNetworkPath(mediaPath, "Local media path");
  } catch (err) {
    throw new LocalMediaAccessError("network-path-not-allowed", (err as Error).message, {
      cause: err,
    });
  }
  const roots = localRoots ?? getDefaultLocalRoots();
  const resolvedVariants = await resolvePathVariants(mediaPath);
  const resolved = resolvedVariants[0] ?? path.resolve(mediaPath);

  if (localRoots === undefined) {
    const workspaceRoot = roots.find((root) => path.basename(root) === "workspace");
    if (workspaceRoot) {
      const stateDir = path.dirname(workspaceRoot);
      const rel = path.relative(stateDir, resolved);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        const firstSegment = rel.split(path.sep)[0] ?? "";
        if (firstSegment.startsWith("workspace-")) {
          throw new LocalMediaAccessError(
            "path-not-allowed",
            `Local media path is not under an allowed directory: ${mediaPath}`,
          );
        }
      }
    }
  }

  for (const root of roots) {
    const resolvedRootVariants = await resolvePathVariants(root);
    if (resolvedRootVariants.some((resolvedRoot) => resolvedRoot === path.parse(resolvedRoot).root)) {
      throw new LocalMediaAccessError(
        "invalid-root",
        `Invalid localRoots entry (refuses filesystem root): ${root}. Pass a narrower directory.`,
      );
    }
    if (
      resolvedVariants.some((resolvedVariant) =>
        resolvedRootVariants.some((resolvedRoot) =>
          isPathWithinRoot(resolvedVariant, resolvedRoot),
        ),
      )
    ) {
      return;
    }
  }

  throw new LocalMediaAccessError(
    "path-not-allowed",
    `Local media path is not under an allowed directory: ${mediaPath}`,
  );
}
