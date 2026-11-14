import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { hasErrnoCode } from "../infra/errno.js";
import { resolveUserPath } from "../utils.js";
import {
  createWorkspaceStateAliases,
  resolveCanonicalWorkspacePath,
  resolveCanonicalWorkspacePathAsync,
  WorkspaceAliasRepointedError,
} from "./workspace-state-identity.js";

type RootFact = { dev: bigint; ino: bigint; mode: bigint; isDirectory: boolean };

export type WorkspaceFilesystemEvidence = {
  workspaceDir: string;
  canonical: string;
  root: (RootFact | undefined)[];
  names?: string[];
};

/** Session writers carry the original target to their existing physical custody boundary. */
export function createWorkspaceFilesystemSource(
  evidence: WorkspaceFilesystemEvidence,
  assertCurrent: () => void,
) {
  const prepared = { assertCurrent, checks: [], workspaceEvidence: [evidence] };
  return Object.assign(() => assertCurrent(), {
    prepareSessionSource: async () => prepared,
    prepareSessionSourceEffect: async () => prepared,
  });
}

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

export async function captureWorkspaceFilesystemEvidence(
  workspaceDir: string,
  content = false,
): Promise<WorkspaceFilesystemEvidence> {
  const dir = path.resolve(resolveUserPath(workspaceDir));
  return {
    workspaceDir: dir,
    canonical: await resolveCanonicalWorkspacePathAsync(dir),
    root: [
      rootFact(await fs.promises.lstat(dir, { bigint: true }).catch(ignoreMissing)),
      rootFact(await fs.promises.stat(dir, { bigint: true }).catch(ignoreMissing)),
    ],
    names: content
      ? ((await fs.promises.readdir(dir).catch(ignoreMissing)) ?? []).toSorted()
      : undefined,
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

export async function validateWorkspaceFilesystemEvidence(
  evidence: WorkspaceFilesystemEvidence,
): Promise<void> {
  assertObservation(
    evidence,
    await captureWorkspaceFilesystemEvidence(evidence.workspaceDir, evidence.names !== undefined),
  );
}

export function installWorkspaceFilesystemEvidence(
  target: readonly WorkspaceFilesystemEvidence[],
  observed: readonly Pick<WorkspaceFilesystemEvidence, "root">[],
): void {
  for (let index = 0; index < target.length; index++) {
    const initial = target[index]!;
    for (let root = 0; root < initial.root.length; root++) {
      initial.root[root] ??= observed[index]!.root[root];
    }
  }
}

export async function prepareWorkspaceStateRead(workspaceDir: string) {
  const dir = path.resolve(resolveUserPath(workspaceDir));
  const initial = await captureWorkspaceFilesystemEvidence(dir);
  return {
    evidence: initial,
    canonicalPath: initial.canonical,
    aliases: createWorkspaceStateAliases(dir, initial.canonical),
    assertCurrent: () => validateWorkspaceFilesystemEvidence(initial),
  };
}
