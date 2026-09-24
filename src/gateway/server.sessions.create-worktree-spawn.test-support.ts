import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function initializeRepositorySeed(root: string, name: string): Promise<void> {
  await fs.mkdir(path.join(root, ".openclaw"), { recursive: true });
  await fs.writeFile(path.join(root, "README.md"), `${name}\n`);
  await fs.writeFile(
    path.join(root, ".openclaw", "worktree-setup.sh"),
    "#!/bin/sh\ntouch setup-marker.txt\n",
    { mode: 0o755 },
  );
  await execFileAsync("git", ["init", "-b", "main", root]);
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", [
    "-C",
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Initialize fixture",
  ]);
}

export function createWorktreeSpawnRepositoryFixture(seedRoot: string) {
  const repositorySeeds = new Set<string>();
  return async (caseRoot: string, name: string): Promise<string> => {
    const seed = path.join(seedRoot, name);
    if (!repositorySeeds.has(name)) {
      await initializeRepositorySeed(seed, name);
      repositorySeeds.add(name);
    }
    const root = path.join(caseRoot, name);
    // Preserve each source's distinct committed README, with private Git metadata per case.
    await fs.cp(seed, root, { recursive: true });
    return await fs.realpath(root);
  };
}
