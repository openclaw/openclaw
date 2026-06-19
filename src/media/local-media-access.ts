// Local media access helpers validate workspace-local media path access.
import fs from "node:fs/promises";
import path from "node:path";
import { isInboundPathAllowed } from "@openclaw/media-core/inbound-path-policy";
import { assertNoWindowsNetworkPath } from "../infra/local-file-access.js";
import { isPathInside } from "../infra/path-guards.js";
import { type LocalMediaRoot, resolveLocalMediaRoot } from "./local-media-root.js";
import { getDefaultMediaLocalRoots } from "./local-roots.js";
import { resolveInboundMediaReference } from "./media-reference.js";

export type { LocalMediaRoot } from "./local-media-root.js";

/** Machine-readable reasons local media path validation can fail. */
export type LocalMediaAccessErrorCode =
  | "path-not-allowed"
  | "invalid-root"
  | "invalid-file-url"
  | "network-path-not-allowed"
  | "unsafe-bypass"
  | "not-found"
  | "invalid-path"
  | "not-file";

/** Error raised when a local media path escapes the configured allowlist. */
export class LocalMediaAccessError extends Error {
  code: LocalMediaAccessErrorCode;

  constructor(code: LocalMediaAccessErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "LocalMediaAccessError";
  }
}

/** Returns the default root allowlist for local media reads. */
export function getDefaultLocalRoots(): readonly string[] {
  return getDefaultMediaLocalRoots();
}

/** Verifies that a local media path is managed inbound media or lives under allowed roots. */
export async function assertLocalMediaAllowed(
  mediaPath: string,
  localRoots: readonly LocalMediaRoot[] | "any" | undefined,
  options?: { inboundRoots?: readonly string[] },
): Promise<void> {
  if (localRoots === "any") {
    return;
  }
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
    // Unscoped default roots include workspace, but not sibling workspace-* agent sandboxes.
    const workspaceRoot = roots.find(
      (root) => path.basename(resolveLocalMediaRoot(root).path) === "workspace",
    );
    if (workspaceRoot) {
      const stateDir = path.dirname(resolveLocalMediaRoot(workspaceRoot).path);
      const rel = path.relative(stateDir, resolved);
      if (rel && isPathInside(stateDir, resolved)) {
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
    const { path: rootPath, kind } = resolveLocalMediaRoot(root);
    let resolvedRoot: string;
    try {
      resolvedRoot = await fs.realpath(rootPath);
    } catch {
      resolvedRoot = path.resolve(rootPath);
    }
    if (resolvedRoot === path.parse(resolvedRoot).root) {
      throw new LocalMediaAccessError(
        "invalid-root",
        `Invalid localRoots entry (refuses filesystem root): ${rootPath}. Pass a narrower directory.`,
      );
    }
    // File roots match the exact path only; dir roots match the root or any descendant.
    if (kind === "file" ? resolved === resolvedRoot : isPathInside(resolvedRoot, resolved)) {
      return;
    }
  }

  throw new LocalMediaAccessError(
    "path-not-allowed",
    `Local media path is not under an allowed directory: ${mediaPath}`,
  );
}
