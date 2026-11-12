import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { hasErrnoCode } from "../infra/errno.js";
import { resolveUserPath } from "../utils.js";
import {
  resolveCanonicalWorkspacePath,
  WorkspaceAliasRepointedError,
} from "./workspace-state-identity.js";

type RootFact = { dev: bigint; ino: bigint; mode: bigint; isDirectory: boolean };

export type WorkspaceFilesystemEvidence = {
  workspaceDir: string;
  canonical: string;
  root: (RootFact | undefined)[];
  names?: string[];
};

function rootFact(stat: fs.BigIntStats | undefined): RootFact | undefined {
  return stat && { dev: stat.dev, ino: stat.ino, mode: stat.mode, isDirectory: stat.isDirectory() };
}

function ignoreMissing(error: unknown): undefined {
  if (!hasErrnoCode(error, "ENOENT") && !hasErrnoCode(error, "ENOTDIR")) {
    throw error;
  }
}

function captureObservation(dir: string, content: boolean): WorkspaceFilesystemEvidence {
  const canonical = resolveCanonicalWorkspacePath(dir);
  const root = [
    rootFact(fs.lstatSync(dir, { bigint: true, throwIfNoEntry: false })),
    rootFact(fs.statSync(dir, { bigint: true, throwIfNoEntry: false })),
  ];
  let names: string[] = [];
  if (content) {
    try {
      names = fs.readdirSync(dir).toSorted();
    } catch (error) {
      ignoreMissing(error);
    }
  }
  return {
    workspaceDir: dir,
    canonical,
    root,
    names: content ? names : undefined,
  };
}

function assertObservation(
  initial: WorkspaceFilesystemEvidence,
  current: WorkspaceFilesystemEvidence,
): void {
  const dir = initial.workspaceDir;
  if (current.canonical !== initial.canonical) {
    throw new WorkspaceAliasRepointedError({
      aliasPath: dir,
      storedWorkspacePath: initial.canonical,
      currentWorkspacePath: current.canonical,
    });
  }
  // Admit first directory creation through an unchanged alias, then pin that
  // inode too. New root entries still invalidate the name observation.
  if (
    initial.root.some(
      (fact, index) =>
        fact !== undefined &&
        (fact.dev !== current.root[index]?.dev ||
          fact.ino !== current.root[index]?.ino ||
          fact.mode !== current.root[index]?.mode),
    ) ||
    (initial.root[1] === undefined && current.root[1] && !current.root[1].isDirectory) ||
    !isDeepStrictEqual(current.names, initial.names)
  ) {
    throw new Error(
      `Workspace filesystem changed while preparing state for ${dir}; retry workspace setup.`,
    );
  }
  for (let index = 0; index < initial.root.length; index++) {
    initial.root[index] ??= current.root[index];
  }
}

export function assertWorkspaceFilesystemEvidence(evidence: WorkspaceFilesystemEvidence): void {
  assertObservation(
    evidence,
    captureObservation(evidence.workspaceDir, evidence.names !== undefined),
  );
}

/** Request-local filesystem evidence; stored NFC keys never select filesystem paths. */
export function captureWorkspaceStateFilesystemGuard(
  workspaceDir: string,
  content = true,
): () => void {
  const dir = path.resolve(resolveUserPath(workspaceDir));
  const initial = captureObservation(dir, content);
  return () => assertWorkspaceFilesystemEvidence(initial);
}
