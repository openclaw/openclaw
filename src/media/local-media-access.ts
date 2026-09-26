// Local media access helpers validate workspace-local media path access.
import type { ReadOptions, ReadOptionsWithBuffer, ReadPosition } from "node:fs";
import fs, { type FileReadResult } from "node:fs/promises";
import path from "node:path";
import { assertNoWindowsNetworkPath, readFileHandleBounded } from "@openclaw/fs-safe/advanced";
import { resolveInboundPathRoot } from "@openclaw/media-core/inbound-path-policy";
import { FsSafeError, openLocalFileSafely } from "../infra/fs-safe.js";
import { isPathInside } from "../infra/path-guards.js";
import { captureChannelReadScope } from "../shared/channel-read-authority.js";
import { getDefaultMediaLocalRoots } from "./local-roots.js";
import { MediaReferenceError, resolveInboundMediaReference } from "./media-reference.js";

/** Machine-readable reasons local media path validation can fail. */
export type LocalMediaAccessErrorCode =
  | "path-not-allowed"
  | "invalid-root"
  | "invalid-file-url"
  | "network-path-not-allowed"
  | "unsafe-bypass"
  | "unsupported-media-type"
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

/**
 * Lets core classify rejected content without changing loadWebMedia's public error code.
 * Removing this boundary would make detailed reply outcomes break plugin error handling.
 */
export class HostReadMediaTypeError extends LocalMediaAccessError {
  constructor(message: string) {
    super("path-not-allowed", message);
  }
}

/** Returns the default root allowlist for local media reads. */
export function getDefaultLocalRootsCore(): readonly string[] {
  return getDefaultMediaLocalRoots();
}

async function resolveCanonicalBoundaryPath(root: string): Promise<string> {
  const resolved = path.resolve(root);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

/** Resolves an allowlist once for callers that validate several media paths. */
export async function resolveLocalMediaRoots(
  localRoots?: readonly string[],
): Promise<readonly string[]> {
  const roots = localRoots ?? getDefaultLocalRootsCore();
  return await Promise.all(
    roots.map(async (root) => {
      const resolvedRoot = await resolveCanonicalBoundaryPath(root);
      if (resolvedRoot === path.parse(resolvedRoot).root) {
        throw new LocalMediaAccessError(
          "invalid-root",
          `Invalid localRoots entry (refuses filesystem root): ${root}. Pass a narrower directory.`,
        );
      }
      return resolvedRoot;
    }),
  );
}

async function resolveLocalMediaPathForContainment(mediaPath: string): Promise<string> {
  try {
    return await fs.realpath(mediaPath);
  } catch {
    // Missing files (for example, staged outbound media supplied by host-read
    // callbacks) still need symlink-aware parent containment.
    try {
      return path.join(await fs.realpath(path.dirname(mediaPath)), path.basename(mediaPath));
    } catch {
      return path.resolve(mediaPath);
    }
  }
}

type ResolvedLocalMediaBoundary = {
  rejectHardlinks: boolean;
  roots: readonly string[] | "any";
};

type ManagedReferenceErrorPolicy = "ignore" | "reject";

async function resolveLocalMediaBoundary(
  mediaPath: string,
  localRoots: readonly string[] | "any" | undefined,
  managedReferenceErrors: ManagedReferenceErrorPolicy,
  options?: {
    inboundRoots?: readonly string[];
    resolvedRoots?: readonly string[];
    resolveRoots?: () => Promise<readonly string[]>;
  },
): Promise<ResolvedLocalMediaBoundary> {
  if (localRoots === "any") {
    return { rejectHardlinks: false, roots: "any" };
  }
  let inboundReference;
  try {
    inboundReference = await resolveInboundMediaReference(mediaPath);
  } catch (err) {
    if (managedReferenceErrors === "reject" && err instanceof MediaReferenceError) {
      throw new LocalMediaAccessError(err.code, err.message, { cause: err });
    }
    if (!(err instanceof MediaReferenceError)) {
      throw err;
    }
  }
  if (inboundReference) {
    return {
      rejectHardlinks: true,
      roots: await resolveLocalMediaRoots([path.dirname(inboundReference.physicalPath)]),
    };
  }
  try {
    assertNoWindowsNetworkPath(mediaPath, "Local media path");
  } catch (err) {
    throw new LocalMediaAccessError("network-path-not-allowed", (err as Error).message, {
      cause: err,
    });
  }
  const matchedInboundRoot = options?.inboundRoots?.length
    ? resolveInboundPathRoot({ filePath: mediaPath, roots: options.inboundRoots })
    : undefined;
  if (matchedInboundRoot) {
    // Channel inbound roots may contain whole-segment wildcards. Freeze the
    // matched root under the stable pre-wildcard anchor so an alias cannot
    // promote an outside directory into the authorized boundary.
    const resolvedAnchor = await resolveCanonicalBoundaryPath(matchedInboundRoot.anchorRoot);
    const resolvedRoot = await resolveCanonicalBoundaryPath(matchedInboundRoot.matchedRoot);
    if (!isPathInside(resolvedAnchor, resolvedRoot)) {
      throw new LocalMediaAccessError(
        "path-not-allowed",
        `Local media path is not under an allowed directory: ${mediaPath}`,
      );
    }
    return {
      rejectHardlinks: true,
      roots: [resolvedRoot],
    };
  }
  const roots = localRoots ?? getDefaultLocalRootsCore();
  const resolved = await resolveLocalMediaPathForContainment(mediaPath);
  const resolvedRoots =
    options?.resolvedRoots ??
    (await options?.resolveRoots?.()) ??
    (await resolveLocalMediaRoots(roots));
  const workspaceRootIndex = roots.findIndex((root) => path.basename(root) === "workspace");
  const workspaceRoot = roots[workspaceRootIndex];
  if (workspaceRoot) {
    const stateDir = await resolveCanonicalBoundaryPath(path.dirname(workspaceRoot));
    const rel = path.relative(stateDir, resolved);
    const firstSegment = rel.split(path.sep)[0] ?? "";
    if (rel && isPathInside(stateDir, resolved) && firstSegment.startsWith("workspace-")) {
      const agentWorkspace = path.join(stateDir, firstSegment);
      // Broad roots such as the shared temp directory must not authorize sibling workspaces.
      const hasScopedWorkspaceRoot =
        localRoots !== undefined &&
        resolvedRoots.some(
          (root) => isPathInside(agentWorkspace, root) && isPathInside(root, resolved),
        );
      if (!hasScopedWorkspaceRoot) {
        throw new LocalMediaAccessError(
          "path-not-allowed",
          `Local media path is not under an allowed directory: ${mediaPath}`,
        );
      }
    }
  }
  for (const [index, resolvedRoot] of resolvedRoots.entries()) {
    const root = roots[index] ?? resolvedRoot;
    if (resolvedRoot === path.parse(resolvedRoot).root) {
      throw new LocalMediaAccessError(
        "invalid-root",
        `Invalid localRoots entry (refuses filesystem root): ${root}. Pass a narrower directory.`,
      );
    }
    if (isPathInside(resolvedRoot, resolved)) {
      return { rejectHardlinks: false, roots: resolvedRoots };
    }
  }

  throw new LocalMediaAccessError(
    "path-not-allowed",
    `Local media path is not under an allowed directory: ${mediaPath}`,
  );
}

/** Verifies that a local media path is managed inbound media or lives under allowed roots. */
export async function assertLocalMediaAllowed(
  mediaPath: string,
  localRoots: readonly string[] | "any" | undefined,
  options?: {
    inboundRoots?: readonly string[];
    resolvedRoots?: readonly string[];
    resolveRoots?: () => Promise<readonly string[]>;
  },
): Promise<void> {
  await resolveLocalMediaBoundary(mediaPath, localRoots, "ignore", options);
}

/** Opens, revalidates, and bounded-reads local media against one frozen root boundary. */
export async function readLocalMediaFile(
  mediaPath: string,
  localRoots: readonly string[] | "any" | undefined,
  options: {
    inboundRoots?: readonly string[];
    maxBytes: number;
    resolvedRoots?: readonly string[];
    resolveRoots?: () => Promise<readonly string[]>;
    /** Local copies of remotely owned roots must not be read through ancestor aliases. */
    excludedRoots?: readonly string[];
  },
): Promise<Buffer> {
  const readScope = captureChannelReadScope();
  readScope?.assertCurrent();
  const boundary = await resolveLocalMediaBoundary(mediaPath, localRoots, "reject", options);
  const excludedRoots = options.excludedRoots?.length
    ? await resolveLocalMediaRoots(options.excludedRoots)
    : [];
  readScope?.assertCurrent();
  await using opened = await openLocalFileSafely({ filePath: mediaPath });
  if (excludedRoots.some((root) => isPathInside(root, opened.realPath))) {
    throw new LocalMediaAccessError(
      "path-not-allowed",
      `Local media path belongs to a remote workspace: ${mediaPath}`,
    );
  }
  if (
    boundary.roots !== "any" &&
    !boundary.roots.some((resolvedRoot) => isPathInside(resolvedRoot, opened.realPath))
  ) {
    throw new LocalMediaAccessError(
      "path-not-allowed",
      `Local media path is not under an allowed directory: ${mediaPath}`,
    );
  }
  if (boundary.rejectHardlinks && opened.stat.nlink > 1) {
    throw new FsSafeError("hardlink", "hardlinked path not allowed");
  }
  if (opened.stat.size > options.maxBytes) {
    throw new FsSafeError(
      "too-large",
      `file exceeds limit of ${options.maxBytes} bytes (got ${opened.stat.size})`,
    );
  }
  if (!readScope) {
    return await readFileHandleBounded(opened.handle, options.maxBytes);
  }
  const guardedHandle = {
    fd: opened.handle.fd,
    async read<T extends NodeJS.ArrayBufferView = Buffer>(
      bufferOrOptions?: T | ReadOptionsWithBuffer<T>,
      offsetOrOptions?: number | null | ReadOptions,
      length?: number | null,
      position?: ReadPosition | null,
    ): Promise<FileReadResult<T>> {
      readScope.assertCurrent();
      const result = ArrayBuffer.isView(bufferOrOptions)
        ? typeof offsetOrOptions === "object" && offsetOrOptions !== null
          ? await opened.handle.read(bufferOrOptions, offsetOrOptions)
          : await opened.handle.read(bufferOrOptions, offsetOrOptions, length, position)
        : await opened.handle.read<T>(bufferOrOptions);
      readScope.assertCurrent();
      return result;
    },
  };
  return await readFileHandleBounded(guardedHandle, options.maxBytes);
}
