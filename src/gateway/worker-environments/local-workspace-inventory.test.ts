import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit, requireGitBuffer } from "../../agents/worktrees/git.js";
import { gitNullConfigPath } from "../../infra/git-exec.js";
import {
  readLocalWorkspaceGitExclusions,
  selectLocalWorkspaceCanonicalPaths,
} from "./local-workspace-inventory.js";
import { workspacePathAncestors } from "./workspace-path-ancestors.js";
import { isIgnoredWorkspaceBuildOutput } from "./workspace-path-exclusions.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

it.each([
  ".cache/\ndist/\n",
  "dist\n.cache/openclaw-bun/\n",
  "dist/a/x\n",
  "*.js\n!dist/keep.js\n",
  "",
])("answers build-output exclusions like a full ignored listing (%j)", async (ignore) => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", gitNullConfigPath());
  vi.stubEnv("GIT_CONFIG_SYSTEM", gitNullConfigPath());
  const root = tempDirs.make("local-workspace-ignored-");
  const files = [
    "dist/a/x",
    "dist/keep.js",
    "dist/b.js",
    "dist-runtime/y",
    ".cache/openclaw-bun/bin/bun",
    ".cache/other/f",
    "src/main.js",
    "nested/dist/z",
  ];
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), file);
  }
  await fs.writeFile(path.join(root, ".gitignore"), ignore);
  await requireGit(root, ["init", "--quiet"]);
  await requireGit(root, ["add", ".gitignore"]);
  const full = new Set(
    (
      await requireGitBuffer(root, [
        "ls-files",
        "--full-name",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "-z",
      ])
    )
      .toString()
      .split("\0")
      .filter(Boolean),
  );
  const scoped = (await readLocalWorkspaceGitExclusions(root, root, new Set())).paths;
  const candidates = new Set(files.flatMap((file) => [file, ...workspacePathAncestors(file)]));
  const answers = (ignored: ReadonlySet<string>) =>
    [...candidates].filter((candidate) => isIgnoredWorkspaceBuildOutput(candidate, ignored));
  expect(answers(scoped)).toEqual(answers(full));
});

it("expands shared ancestors with linear path-insertion work", async () => {
  const directories = ["source", "source/a", "source/a/b", "source/a/b/c", "source/a/b/c/d"];
  const files = Array.from({ length: 64 }, (_, index) => `${directories.at(-1)}/${index}.txt`);
  const preparedPaths = new Set(files);
  const observed = vi.spyOn(Set.prototype, "add");
  let paths: Set<string>;
  let insertions: number;
  try {
    paths = await selectLocalWorkspaceCanonicalPaths({
      root: "/unused-prepared-inventory",
      preparedPaths,
      baselinePaths: new Set(["source/saved/retained.txt"]),
      assertCurrent() {},
    });
    insertions = observed.mock.calls.filter(
      ([value]) => typeof value === "string" && (value === "source" || value.startsWith("source/")),
    ).length;
  } finally {
    observed.mockRestore();
  }
  expect(paths).toEqual(
    new Set([...files, ...directories, "source/saved/retained.txt", "source/saved"]),
  );
  // Each admitted path and directory can enter the inventory and contribute a
  // parent; shared ancestors must not multiply that work by directory depth.
  expect(insertions).toBeLessThanOrEqual(2 * paths.size);
});
