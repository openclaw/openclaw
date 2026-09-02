import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  removeChildDirectoryIfIdentityMatches,
  root as fsRoot,
  sanitizeUntrustedFileName,
  type Root,
} from "../infra/fs-safe.js";
import type { MediaFact } from "./media-facts.js";

const STAGED_INPUT_DIRECTORY_PREFIX = "media/inbound/openclaw-staged-";
export const STAGED_INPUT_GIT_PATHSPEC = `:(glob)${STAGED_INPUT_DIRECTORY_PREFIX}*/**`;
const STAGED_INPUT_GITIGNORE =
  "# Raw task inputs remain private; copy outputs into the project to publish.\n*\n";

const STAGED_INPUT_GITIGNORE_SHA256 = createHash("sha256")
  .update(STAGED_INPUT_GITIGNORE)
  .digest("hex");

const producerMintedStagingDirectories = new Set<string>();

export function registerProducedStagingDirectory(directoryPath: string): void {
  producerMintedStagingDirectories.add(path.resolve(directoryPath));
}

export function isRegisteredStagingDirectory(directoryPath: string): boolean {
  return producerMintedStagingDirectories.has(path.resolve(directoryPath));
}

function unregisterStagingDirectory(directoryPath: string): void {
  producerMintedStagingDirectories.delete(path.resolve(directoryPath));
}

if (process.env.NODE_ENV === "test" || process.env.VITEST) {
  // SAFETY: Test API registration on globalThis in test environment
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.stagedInputsTestApi")] = {
    getRegisteredStagingDirectoriesCount: () => producerMintedStagingDirectories.size,
  };
}

/** A directory basename is only a candidate if it matches the owned staging format. */
function isOwnedStagedInputDirectoryName(name: string): boolean {
  if (!name.startsWith("openclaw-staged-")) {
    return false;
  }
  const identity = name.slice("openclaw-staged-".length);
  const match =
    /^(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/u.exec(
      identity,
    );
  return match?.[0] === identity;
}

/** A producer-shaped name is only a candidate; the marker establishes ownership. */
export function stagedInputPathDirectory(relativePath: string): string | undefined {
  if (!relativePath.startsWith(STAGED_INPUT_DIRECTORY_PREFIX)) {
    return undefined;
  }
  const identity = relativePath.slice(STAGED_INPUT_DIRECTORY_PREFIX.length).split("/")[0]!;
  const match =
    /^(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/u.exec(
      identity,
    );
  return match?.[0] === identity ? STAGED_INPUT_DIRECTORY_PREFIX + identity : undefined;
}

export function isStagedInputPath(relativePath: string, directories: ReadonlySet<string>): boolean {
  const directory = stagedInputPathDirectory(relativePath);
  return directory !== undefined && directories.has(directory);
}

/** Capture-scoped, including negative results: never read the marker once per file. */
export function createStagedInputPathMatcher(
  root: Root,
): (relativePath: string) => Promise<boolean> {
  const directories = new Map<string, Promise<boolean>>();
  return async (relativePath) => {
    const directory = stagedInputPathDirectory(relativePath);
    if (!directory) {
      return false;
    }
    let owned = directories.get(directory);
    if (!owned) {
      owned = root
        .readText(`${directory}/.gitignore`, { maxBytes: STAGED_INPUT_GITIGNORE.length })
        .then(
          (text) => text === STAGED_INPUT_GITIGNORE,
          () => false,
        );
      directories.set(directory, owned);
    }
    return await owned;
  };
}

/** Complete manifests bind the regular marker's exact bytes through their file digest. */
export function stagedInputDirectoriesFromEntries(
  entries: readonly { path: string; type: string; size?: number; sha256?: string }[],
): Set<string> {
  const directories = new Set<string>();
  for (const entry of entries) {
    const directory = stagedInputPathDirectory(entry.path);
    if (
      directory &&
      entry.path === `${directory}/.gitignore` &&
      entry.type === "file" &&
      entry.size === STAGED_INPUT_GITIGNORE.length &&
      entry.sha256 === STAGED_INPUT_GITIGNORE_SHA256
    ) {
      directories.add(directory);
    }
  }
  return directories;
}

export const STAGED_INPUT_PATHS_JS = `
const STAGED_INPUT_DIRECTORY_PREFIX = ${JSON.stringify(STAGED_INPUT_DIRECTORY_PREFIX)};
const STAGED_INPUT_GITIGNORE = ${JSON.stringify(STAGED_INPUT_GITIGNORE)};
const STAGED_INPUT_GITIGNORE_SHA256 = ${JSON.stringify(STAGED_INPUT_GITIGNORE_SHA256)};
const stagedInputPathDirectory = ${stagedInputPathDirectory.toString()};
const isStagedInputPath = ${isStagedInputPath.toString()};
const stagedInputDirectoriesFromEntries = ${stagedInputDirectoriesFromEntries.toString()};`;

export function stagedInputDirectory(identity: string): string {
  return `${STAGED_INPUT_DIRECTORY_PREFIX}${identity}`;
}

export function stagedInputFileName(name: string): string {
  // A generic prefix keeps uploaded Git control filenames ordinary input files.
  return sanitizeUntrustedFileName(`input-${name}`, "input-attachment");
}

/** Maps producer-stamped upload handles to exact private paths for the current turn. */
export function resolveStagedInputMediaPaths(
  media: readonly MediaFact[] | undefined,
): ReadonlyMap<string, string> {
  const paths = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const fact of media ?? []) {
    if (fact.staged !== true || !fact.path) {
      continue;
    }
    const directory = stagedInputPathDirectory(fact.path);
    const prefix = directory ? `${directory}/input-` : undefined;
    if (!prefix || !fact.path.startsWith(prefix)) {
      continue;
    }
    const fileName = fact.path.slice(prefix.length);
    if (!/^file_[^/\\]+$/u.test(fileName)) {
      continue;
    }
    const extension = path.posix.extname(fileName);
    const aliases = extension ? [fileName, fileName.slice(0, -extension.length)] : [fileName];
    for (const alias of aliases) {
      if (ambiguous.has(alias)) {
        continue;
      }
      const existing = paths.get(alias);
      if (existing && existing !== fact.path) {
        // A duplicate alias has no authoritative target; input order must not select one.
        paths.delete(alias);
        ambiguous.add(alias);
      } else {
        paths.set(alias, fact.path);
      }
    }
  }
  return paths;
}

export async function ensureStagedInputDirectory(
  rootDir: string,
  directory: string,
  signal?: AbortSignal,
): Promise<void> {
  const root = await fsRoot(rootDir);
  const ignorePath = `${directory}/.gitignore`;
  if (await root.exists(directory)) {
    if ((await root.readText(ignorePath, { maxBytes: 1024 })) !== STAGED_INPUT_GITIGNORE) {
      throw new Error("Input staging directory is not owned by OpenClaw");
    }
    return;
  }
  // Never add an exclusion to an existing project directory or replace its files.
  signal?.throwIfAborted();
  await root.create(ignorePath, STAGED_INPUT_GITIGNORE, { mode: 0o600 });
}

export async function cleanEmptyStagingDirectorySafely(
  hostWorkspaceStagingDir: string,
): Promise<void> {
  const dirName = path.basename(hostWorkspaceStagingDir);
  if (!isOwnedStagedInputDirectoryName(dirName)) {
    return;
  }
  const parentDir = path.dirname(hostWorkspaceStagingDir);
  const [parentRoot, stagingRoot, dirStat] = await Promise.all([
    fsRoot(parentDir).catch(() => null),
    fsRoot(hostWorkspaceStagingDir).catch(() => null),
    fs.lstat(hostWorkspaceStagingDir).catch(() => null),
  ]);
  if (
    !parentRoot ||
    !stagingRoot ||
    !dirStat ||
    !dirStat.isDirectory() ||
    dirStat.isSymbolicLink()
  ) {
    return;
  }
  const files = await stagingRoot.list("").catch(() => null);
  if (!files || files.length !== 1 || files[0] !== ".gitignore") {
    return;
  }
  const markerContent = await stagingRoot
    .readText(".gitignore", { maxBytes: STAGED_INPUT_GITIGNORE.length })
    .catch(() => null);
  if (markerContent !== STAGED_INPUT_GITIGNORE) {
    return;
  }
  try {
    await stagingRoot.remove(".gitignore");
  } catch {
    return;
  }
  // If a concurrent write occurred after marker deletion, preserve directory and restore marker
  const remaining = await stagingRoot.list("").catch(() => null);
  if (remaining && remaining.length > 0) {
    await stagingRoot.create(".gitignore", Buffer.from(STAGED_INPUT_GITIGNORE)).catch(() => {});
    return;
  }

  // Final removal primitive: atomically isolates directory to eliminate replaceable-path deletion
  const removed = await removeChildDirectoryIfIdentityMatches({
    parentRoot,
    dirName,
    expectedIdentity: dirStat,
  });

  if (!removed) {
    const dirStillExists = await fs
      .lstat(hostWorkspaceStagingDir)
      .then((s) => s.isDirectory() && !s.isSymbolicLink())
      .catch(() => false);
    if (dirStillExists) {
      const restoredRoot = await fsRoot(hostWorkspaceStagingDir).catch(() => null);
      if (restoredRoot) {
        await restoredRoot
          .create(".gitignore", Buffer.from(STAGED_INPUT_GITIGNORE))
          .catch(() => {});
      }
    }
  }
}

export function cleanHostWorkspaceStaging(run: { hostWorkspaceStagingDir?: string }): void {
  const hostWorkspaceStagingDir = run.hostWorkspaceStagingDir;
  if (hostWorkspaceStagingDir) {
    delete run.hostWorkspaceStagingDir;
    // Must be a producer-minted staging directory registered by stageSandboxMedia
    if (!isRegisteredStagingDirectory(hostWorkspaceStagingDir)) {
      return;
    }
    unregisterStagingDirectory(hostWorkspaceStagingDir);
    // Remove only if empty (or marker-only): staged files are persisted into the transcript and
    // re-read by history hydration on subsequent turns. Recursive deletion
    // would destroy attachments still needed by the running session.
    void cleanEmptyStagingDirectorySafely(hostWorkspaceStagingDir);
  }
}
