import fs from "node:fs/promises";
import path from "node:path";
import { isInboundPathAllowed } from "@openclaw/media-core/inbound-path-policy";
import { assertNoWindowsNetworkPath } from "../infra/local-file-access.js";
import { isPathInside } from "../infra/path-guards.js";
import { getDefaultMediaLocalRoots } from "./local-roots.js";
import { resolveInboundMediaReference } from "./media-reference.js";

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
  /** Stable machine-readable access failure reason for callers and tests. */
  code: LocalMediaAccessErrorCode;

  constructor(code: LocalMediaAccessErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "LocalMediaAccessError";
  }
}

/** Returns the process default roots used when callers do not pass scoped localRoots. */
export function getDefaultLocalRoots(): readonly string[] {
  return getDefaultMediaLocalRoots();
}

/**
 * Enforce local media read access against managed inbound media and configured
 * root allowlists.
 */
export async function assertLocalMediaAllowed(
  mediaPath: string,
  localRoots: readonly string[] | "any" | undefined,
  options?: { inboundRoots?: readonly string[] },
): Promise<void> {
  if (localRoots === "any") {
    return;
  }
  // Managed inbound media is already staged by OpenClaw; allow the canonical flat inbound
  // reference even when a caller passes no localRoots.
  const inboundReference = await resolveInboundMediaReference(mediaPath).catch(() => null);
  if (inboundReference) {
    return;
  }
  try {
    assertNoWindowsNetworkPath(mediaPath, "Local media path");
  } catch (err) {
    throw new LocalMediaAccessError("network-path-not-allowed", (err as Error).message, {
      cause: err,
    });
  }
  if (
    options?.inboundRoots?.length &&
    isInboundPathAllowed({ filePath: mediaPath, roots: options.inboundRoots })
  ) {
    // Channel-specific inbound roots are trusted staging areas supplied by the channel contract.
    return;
  }
  const roots = localRoots ?? getDefaultLocalRoots();
  let resolved: string;
  try {
    resolved = await fs.realpath(mediaPath);
  } catch {
    resolved = path.resolve(mediaPath);
  }

  if (localRoots === undefined) {
    const workspaceRoot = roots.find((root) => path.basename(root) === "workspace");
    if (workspaceRoot) {
      const stateDir = path.dirname(workspaceRoot);
      const rel = path.relative(stateDir, resolved);
      if (rel && isPathInside(stateDir, resolved)) {
        const firstSegment = rel.split(path.sep)[0] ?? "";
        if (firstSegment.startsWith("workspace-")) {
          // Unscoped defaults expose the shared workspace, not every agent workspace-* sibling
          // under the state dir. Scoped localRoots can opt into a specific sibling explicitly.
          throw new LocalMediaAccessError(
            "path-not-allowed",
            `Local media path is not under an allowed directory: ${mediaPath}`,
          );
        }
      }
    }
  }

  for (const root of roots) {
    let resolvedRoot: string;
    try {
      resolvedRoot = await fs.realpath(root);
    } catch {
      resolvedRoot = path.resolve(root);
    }
    if (resolvedRoot === path.parse(resolvedRoot).root) {
      // A root allowlist entry of "/" or "C:\" would make every local path readable.
      throw new LocalMediaAccessError(
        "invalid-root",
        `Invalid localRoots entry (refuses filesystem root): ${root}. Pass a narrower directory.`,
      );
    }
    if (isPathInside(resolvedRoot, resolved)) {
      return;
    }
  }

  throw new LocalMediaAccessError(
    "path-not-allowed",
    `Local media path is not under an allowed directory: ${mediaPath}`,
  );
}
