import { createHash } from "node:crypto";
import path from "node:path";
import { compileFunction } from "node:vm";
import { root as fsRoot, sanitizeUntrustedFileName, type Root } from "../infra/fs-safe.js";
import type { MediaFact } from "./media-facts.js";

/** Existing per-file allowance for staging task inputs. */
export const STAGED_INPUT_MAX_BYTES = 50 * 1024 * 1024;

const STAGED_INPUT_DIRECTORY_PREFIX = "media/inbound/openclaw-staged-";
export const STAGED_INPUT_GIT_PATHSPEC = `:(glob)${STAGED_INPUT_DIRECTORY_PREFIX}*/**`;
const STAGED_INPUT_GITIGNORE =
  "# Raw task inputs remain private; copy outputs into the project to publish.\n*\n";

const STAGED_INPUT_GITIGNORE_SHA256 = createHash("sha256")
  .update(STAGED_INPUT_GITIGNORE)
  .digest("hex");

// Host and remote inventories execute this same source, independent of the
// module loader's import rewriting and function-name helpers.
export const STAGED_INPUT_PATHS_JS = String.raw`
const STAGED_INPUT_DIRECTORY_PREFIX = ${JSON.stringify(STAGED_INPUT_DIRECTORY_PREFIX)};
const STAGED_INPUT_GITIGNORE = ${JSON.stringify(STAGED_INPUT_GITIGNORE)};
const STAGED_INPUT_GITIGNORE_SHA256 = ${JSON.stringify(STAGED_INPUT_GITIGNORE_SHA256)};
// A producer-shaped name is only a candidate; the marker establishes ownership.
function stagedInputPathDirectory(relativePath) {
  if (!relativePath.startsWith(STAGED_INPUT_DIRECTORY_PREFIX)) {
    return undefined;
  }
  const identity = relativePath.slice(STAGED_INPUT_DIRECTORY_PREFIX.length).split("/")[0];
  const match =
    /^(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/u.exec(
      identity,
    );
  return match?.[0] === identity ? STAGED_INPUT_DIRECTORY_PREFIX + identity : undefined;
}

function isStagedInputPath(relativePath, directories) {
  const directory = stagedInputPathDirectory(relativePath);
  return directory !== undefined && directories.has(directory);
}

// Complete manifests bind the regular marker's exact bytes through their file digest.
function stagedInputDirectoriesFromEntries(entries) {
  const directories = new Set();
  for (const entry of entries) {
    const directory = stagedInputPathDirectory(entry.path);
    if (
      directory &&
      entry.path === directory + "/.gitignore" &&
      entry.type === "file" &&
      entry.size === STAGED_INPUT_GITIGNORE.length &&
      entry.sha256 === STAGED_INPUT_GITIGNORE_SHA256
    ) {
      directories.add(directory);
    }
  }
  return directories;
}`;

export const {
  stagedInputPathDirectory,
  isStagedInputPath,
  stagedInputDirectoriesFromEntries,
}: {
  stagedInputPathDirectory: (relativePath: string) => string | undefined;
  isStagedInputPath: (relativePath: string, directories: ReadonlySet<string>) => boolean;
  stagedInputDirectoriesFromEntries: (
    entries: readonly { path: string; type: string; size?: number; sha256?: string }[],
  ) => Set<string>;
} = compileFunction(
  `${STAGED_INPUT_PATHS_JS}\nreturn { stagedInputPathDirectory, isStagedInputPath, stagedInputDirectoriesFromEntries };`,
)();

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

type StagedInputFileSystem = {
  exists: (filePath: string) => Promise<boolean>;
  readText: (filePath: string, options: { maxBytes: number }) => Promise<string>;
  create: (
    filePath: string,
    data: string,
    options: { mode: number; assertBeforeMutation: () => void },
  ) => Promise<unknown>;
};

export async function ensureStagedInputDirectory(
  rootDir: string | StagedInputFileSystem,
  directory: string,
  signal?: AbortSignal,
): Promise<void> {
  const root = typeof rootDir === "string" ? await fsRoot(rootDir) : rootDir;
  const ignorePath = `${directory}/.gitignore`;
  if (await root.exists(directory)) {
    if ((await root.readText(ignorePath, { maxBytes: 1024 })) !== STAGED_INPUT_GITIGNORE) {
      throw new Error("Input staging directory is not owned by OpenClaw");
    }
    return;
  }
  // Never add an exclusion to an existing project directory or replace its files.
  signal?.throwIfAborted();
  await root.create(ignorePath, STAGED_INPUT_GITIGNORE, {
    mode: 0o600,
    assertBeforeMutation: () => signal?.throwIfAborted(),
  });
}
