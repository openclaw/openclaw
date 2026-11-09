import fs from "node:fs/promises";
import type { FsSafeProvisionCopyDiagnostics } from "../../infra/fs-safe-copy-worker-contract.js";
import { root as fsRoot, FsSafeError, type Root } from "../../infra/fs-safe.js";
import { lstatIfExists } from "../../infra/path-existence.js";
import {
  hasSafeParentDirectories,
  normalizeProvisionedRelativePath,
  resolveGitPath,
} from "./provisioned-file-inspection.js";

async function copyProvisionedFile(params: {
  sourceRoot: Root;
  destinationRoot: Root;
  relativePath: string;
  assertCurrent?: () => void;
  signal?: AbortSignal;
  diagnostics: FsSafeProvisionCopyDiagnostics;
}): Promise<boolean> {
  const relativePath = params.relativePath;
  const diagnostics = params.diagnostics;
  const preflightStartedAt = performance.now();
  let sourceBytes = 0;
  let source: string;
  let destination: string;
  try {
    // Eligibility checks preserve skip behavior; copyIn guards the later mutation.
    if (
      !(await hasSafeParentDirectories(params.sourceRoot.rootReal, relativePath)) ||
      !(await hasSafeParentDirectories(params.destinationRoot.rootReal, relativePath))
    ) {
      return false;
    }
    source = resolveGitPath(params.sourceRoot.rootReal, relativePath);
    destination = resolveGitPath(params.destinationRoot.rootReal, relativePath);
    const sourceStat = await fs.lstat(source).catch(() => undefined);
    if (!sourceStat?.isFile() || sourceStat.isSymbolicLink()) {
      return false;
    }
    if (await lstatIfExists(destination, "ENOENT")) {
      return false;
    }
    sourceBytes = sourceStat.size;
  } finally {
    diagnostics.preflightMs =
      (diagnostics.preflightMs ?? 0) + performance.now() - preflightStartedAt;
  }
  diagnostics.attemptedFiles = (diagnostics.attemptedFiles ?? 0) + 1;
  // Logical source size at the existing lstat, not physical IO or copied bytes.
  diagnostics.sourceBytes = Math.min(
    Number.MAX_SAFE_INTEGER,
    (diagnostics.sourceBytes ?? 0) + sourceBytes,
  );
  const copyStartedAt = performance.now();
  try {
    // Absolute spellings preserve Git's literal "~" and POSIX drive-like filenames.
    await params.destinationRoot.copyIn(
      destination,
      { root: params.sourceRoot, relativePath: source },
      {
        overwrite: false,
        clone: "auto",
        maxBytes: Infinity,
        preserveSourceMode: true,
        preserveMetadata: true,
        sourceHardlinks: "allow",
        mutationSymlinks: "reject",
        durable: false,
        assertBeforeMutation: params.assertCurrent,
        signal: params.signal,
      },
    );
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "already-exists") {
      // Existing checkout state is user-owned. Never mutate or claim it as provisioned.
      return false;
    }
    throw error;
  } finally {
    // Includes Root admission, native queueing, and nested authority assertions.
    diagnostics.copyAwaitMs = (diagnostics.copyAwaitMs ?? 0) + performance.now() - copyStartedAt;
  }
  params.assertCurrent?.();
  return true;
}

/** The worker native section retains every copy descriptor through settlement. */
export async function copyProvisionedPaths(
  repoRoot: string,
  worktreePath: string,
  paths: readonly string[],
  options: {
    signal?: AbortSignal;
    assertCurrent?: () => void;
    diagnostics?: FsSafeProvisionCopyDiagnostics;
  },
): Promise<string[]> {
  const diagnostics = options.diagnostics ?? {};
  Object.assign(diagnostics, {
    preflightMs: 0,
    authorityWaitMs: 0,
    copyAwaitMs: 0,
    attemptedFiles: 0,
    copiedFiles: 0,
    sourceBytes: 0,
  });
  const assertCurrent = options.assertCurrent
    ? () => {
        const startedAt = performance.now();
        try {
          options.assertCurrent?.();
        } finally {
          diagnostics.authorityWaitMs =
            (diagnostics.authorityWaitMs ?? 0) + performance.now() - startedAt;
        }
      }
    : undefined;
  const rootsStartedAt = performance.now();
  let roots: [Root, Root];
  try {
    roots = await Promise.all([fsRoot(repoRoot), fsRoot(worktreePath)]);
  } finally {
    diagnostics.preflightMs = performance.now() - rootsStartedAt;
  }
  const [sourceRoot, destinationRoot] = roots;
  const provisioned: string[] = [];
  for (const relativePath of paths) {
    const normalized = normalizeProvisionedRelativePath(relativePath);
    if (
      normalized &&
      (await copyProvisionedFile({
        sourceRoot,
        destinationRoot,
        relativePath: normalized,
        assertCurrent,
        diagnostics,
        signal: options.signal,
      }))
    ) {
      provisioned.push(normalized);
      diagnostics.copiedFiles = (diagnostics.copiedFiles ?? 0) + 1;
    }
  }
  return provisioned.toSorted();
}
