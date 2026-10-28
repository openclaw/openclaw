import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
import type { WorktreeFilesystemOptions } from "./filesystem-backend.types.js";
import { requireGit, requireGitBuffer } from "./git.js";

const PROFILE_DIRECTORY = ".openclaw/worktree-profiles";
const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const PROFILE_MAX_BYTES = 64 * 1024;

export type WorktreeSourceProfile = {
  commit: string;
  directories: readonly string[];
};

/** Resolve repository-owned cone lists without consulting mutable checkout files. */
export async function resolveWorktreeSourceProfile(
  repoRoot: string,
  base: string,
  names: readonly string[],
  options: WorktreeFilesystemOptions,
): Promise<WorktreeSourceProfile> {
  if (
    names.length === 0 ||
    names.some((name) => typeof name !== "string" || !PROFILE_NAME.test(name))
  ) {
    throw new Error(
      "Select a worktree profile using a lowercase name of up to 64 letters, digits, or hyphens.",
    );
  }
  const assertOwned = () => {
    options.signal?.throwIfAborted();
    options.commitGuard();
  };
  assertOwned();
  const gitOptions = {
    signal: options.signal,
    beforeRun: assertOwned,
    killProcessTree: true,
  };
  const commit = await requireGit(
    repoRoot,
    ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`],
    gitOptions,
  );
  const directories = new Set([PROFILE_DIRECTORY]);
  for (const name of [...new Set(names)].toSorted()) {
    const definition = `${PROFILE_DIRECTORY}/${name}`;
    const entry = await requireGit(
      repoRoot,
      ["ls-tree", "-z", commit, "--", `:(literal)${definition}`],
      { ...gitOptions, maxOutputBytes: 4096, terminateOnOutputLimit: true },
    );
    const match = /^(?:100644|100755) blob ([a-f0-9]+)\t[^\0]+\0$/u.exec(entry);
    if (!match) {
      throw new Error(
        `Worktree profile ${definition} must be a tracked regular file at ${commit}.`,
      );
    }
    const contents = await requireGitBuffer(repoRoot, ["cat-file", "blob", match[1]!], {
      ...gitOptions,
      maxOutputBytes: PROFILE_MAX_BYTES,
    });
    const text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
    for (const directory of text.split(/\r?\n/u)) {
      if (!directory) {
        continue;
      }
      const invalidComponent = directory
        .split("/")
        .some(
          (part) =>
            !part ||
            part !== part.trim() ||
            part === "." ||
            part === ".." ||
            part.toLowerCase() === ".git",
        );
      // These are literal cone directories, not patterns, commands or C-quoted paths.
      if (
        invalidComponent ||
        containsAsciiControlCharacter(directory) ||
        /[\\:*?[\]!"<>|]/u.test(directory)
      ) {
        throw new Error(
          `Worktree profile ${definition} contains an invalid cone directory: ${JSON.stringify(directory)}.`,
        );
      }
      directories.add(directory);
    }
  }
  for (const directory of directories) {
    // Query only the selected entry. A truncated whole-tree inventory must not
    // silently validate a prefix, and a symlink/submodule is not a cone tree.
    const entry = await requireGitBuffer(
      repoRoot,
      ["ls-tree", "-d", "-z", commit, "--", `:(literal)${directory}`],
      { ...gitOptions, maxOutputBytes: PROFILE_MAX_BYTES },
    );
    if (!/^040000 tree [a-f0-9]+\t[^\0]+\0$/u.test(entry.toString("utf8"))) {
      throw new Error(
        `Worktree profile directory ${directory} is not a tracked directory at ${commit}.`,
      );
    }
  }
  assertOwned();
  return { commit, directories: [...directories].toSorted() };
}
