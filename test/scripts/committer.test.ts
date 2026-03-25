import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = path.join(process.cwd(), "scripts", "committer");
const tempRepos: string[] = [];

function run(cwd: string, command: string, args: string[]) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
  }).trim();
}

function git(cwd: string, ...args: string[]) {
  return run(cwd, "git", args);
}

function createRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "committer-test-"));
  tempRepos.push(repo);

  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  git(repo, "add", "seed.txt");
  git(repo, "commit", "-qm", "seed");

  return repo;
}

function writeRepoFile(repo: string, relativePath: string, contents: string) {
  const fullPath = path.join(repo, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents);
}

function commitWithHelper(repo: string, commitMessage: string, ...args: string[]) {
  return run(repo, "bash", [scriptPath, commitMessage, ...args]);
}

function committedPaths(repo: string) {
  const output = git(repo, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD");
  return output.split("\n").filter(Boolean).toSorted();
}

afterEach(() => {
  while (tempRepos.length > 0) {
    const repo = tempRepos.pop();
    if (repo) {
      rmSync(repo, { force: true, recursive: true });
    }
  }
});

describe("scripts/committer", () => {
  it("accepts supported path argument shapes", () => {
    const cases = [
      {
        commitMessage: "test: plain argv",
        files: [
          ["alpha.txt", "alpha\n"],
          ["nested/file with spaces.txt", "beta\n"],
        ] as const,
        args: ["alpha.txt", "nested/file with spaces.txt"],
        expected: ["alpha.txt", "nested/file with spaces.txt"],
      },
      {
        commitMessage: "test: space blob",
        files: [
          ["alpha.txt", "alpha\n"],
          ["beta.txt", "beta\n"],
        ] as const,
        args: ["alpha.txt beta.txt"],
        expected: ["alpha.txt", "beta.txt"],
      },
      {
        commitMessage: "test: newline blob",
        files: [
          ["alpha.txt", "alpha\n"],
          ["nested/file with spaces.txt", "beta\n"],
        ] as const,
        args: ["alpha.txt\nnested/file with spaces.txt"],
        expected: ["alpha.txt", "nested/file with spaces.txt"],
      },
    ] as const;

    for (const testCase of cases) {
      const repo = createRepo();
      for (const [file, contents] of testCase.files) {
        writeRepoFile(repo, file, contents);
      }

      commitWithHelper(repo, testCase.commitMessage, ...testCase.args);

      expect(committedPaths(repo)).toEqual(testCase.expected);
    }
  });

  it("commits changelog-only changes without pulling in unrelated dirty files", () => {
    const repo = createRepo();
    writeRepoFile(repo, "CHANGELOG.md", "initial\n");
    writeRepoFile(repo, "unrelated.ts", "export const ok = true;\n");
    git(repo, "add", "CHANGELOG.md", "unrelated.ts");
    git(repo, "commit", "-qm", "seed extra files");

    writeRepoFile(repo, "CHANGELOG.md", "breaking note\n");
    writeRepoFile(repo, "unrelated.ts", "<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> branch\n");

    commitWithHelper(repo, "docs(changelog): note breaking change", "CHANGELOG.md");

    expect(committedPaths(repo)).toEqual(["CHANGELOG.md"]);
    expect(git(repo, "status", "--short")).toContain("M unrelated.ts");
  });
});
