import fs from "node:fs/promises";
import path from "node:path";
import { assertNoWindowsNetworkPath } from "../infra/local-file-access.js";
import { isPathInside } from "../infra/path-guards.js";
import { getDefaultMediaLocalRoots } from "./local-roots.js";
import { resolveInboundMediaReference } from "./media-reference.js";

// Cap the allowed-roots hint so a misconfigured config with hundreds of
// roots cannot blow up the error message length. The first 4 roots are
// usually enough context (workspace + state + media-inbound + media-outbound)
// for the operator to pick the right destination.
const ALLOWED_ROOTS_HINT_LIMIT = 4;

function formatAllowedRootsHint(roots: readonly string[]): string {
  if (roots.length === 0) {
    return "<no roots configured>";
  }
  const visible = roots.slice(0, ALLOWED_ROOTS_HINT_LIMIT);
  const overflow = roots.length - visible.length;
  const formatted = visible.join(", ");
  return overflow > 0 ? `${formatted}, +${overflow} more` : formatted;
}

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

export async function assertLocalMediaAllowed(
  mediaPath: string,
  localRoots: readonly string[] | "any" | undefined,
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
          throw new LocalMediaAccessError(
            "path-not-allowed",
            `Local media path is not under an allowed directory: ${mediaPath} (allowed roots: ${formatAllowedRootsHint(roots)})`,
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
    `Local media path is not under an allowed directory: ${mediaPath} (allowed roots: ${formatAllowedRootsHint(roots)})`,
  );
}
