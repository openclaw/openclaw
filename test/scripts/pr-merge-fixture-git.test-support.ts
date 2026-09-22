import { execFileSync } from "node:child_process";

export function createFixtureGit(repo: string, gitEnv: NodeJS.ProcessEnv) {
  const git = (args: string[], input?: string, cwd = repo, env?: NodeJS.ProcessEnv) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd,
      env: { ...gitEnv, ...env },
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  const tree = (owner: string, sibling = "stable\n") => {
    const a = git(["hash-object", "-w", "--stdin"], owner);
    const b = git(["hash-object", "-w", "--stdin"], sibling);
    return git(["mktree"], `100644 blob ${a}\towner.txt\n100644 blob ${b}\tsibling.txt\n`);
  };
  const commit = (
    contents: string,
    parents: string[],
    message = "Fixture commit\n",
    author?: { name: string; email: string },
  ) =>
    git(
      ["commit-tree", contents, ...parents.flatMap((parent) => ["-p", parent])],
      message,
      repo,
      author
        ? {
            GIT_AUTHOR_NAME: author.name,
            GIT_AUTHOR_EMAIL: author.email,
            GIT_COMMITTER_NAME: author.name,
            GIT_COMMITTER_EMAIL: author.email,
          }
        : undefined,
    );
  return { git, tree, commit };
}
