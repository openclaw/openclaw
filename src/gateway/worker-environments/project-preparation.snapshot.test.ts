import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import {
  createWorkerProjectPreparation,
  readWorkerProjectEnvironmentRecipe,
} from "./project-preparation.js";
import { createProjectPreparationFixture } from "./project-preparation.test-support.js";
import {
  prepareWorkerProjectSnapshot,
  prepareWorkerWorkspaceGitPack,
} from "./workspace-git-base.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fixture = (setup?: string) =>
  createProjectPreparationFixture(tempDirs.make("project-snapshot-"), setup);
const readText = (root: string, ...parts: string[]) =>
  fs.readFile(path.join(root, ...parts), "utf8");
const snapshot = async (localPath: string) =>
  (await prepareWorkerProjectSnapshot({ localPath, namespace: "gateway" }))!;
async function prepare(f: Awaited<ReturnType<typeof fixture>>) {
  const owner = await f.preparedOperation();
  try {
    return await owner.project.prepare(f);
  } finally {
    owner.close();
  }
}

describe("prepared repository snapshot bases", () => {
  it("starts an admitted moving default branch on its completed snapshot without setup or transfer", async () => {
    const f = await fixture('#!/bin/sh\nprintf "setup\n" >> "$HOME/setup-count"\n');
    const first = await prepare(f);
    const workspace = first.preparedWorkspace!;
    await requireGit(f.repository, ["commit", "--allow-empty", "--quiet", "-m", "branch advanced"]);
    const latest = await snapshot(f.repository);
    const recipe = await readWorkerProjectEnvironmentRecipe(latest);
    const revalidate = vi.fn(async () => {});
    const owner = createWorkerProjectPreparation({
      project: {
        key: f.project.key,
        baseCommit: latest.baseCommit,
        source: {
          kind: "repository",
          url: "https://github.com/acme/project.git",
          repositoryId: "R_fixture",
          owner: {
            agent: { agentId: "main", provenance: null },
            identity: { source: "anonymous" },
          },
        },
      },
      namespace: "gateway",
      preparation: {
        key: "b".repeat(64),
        cacheKey: "c".repeat(64),
        purpose: "session",
        demandAtMs: 1,
        setupRecipe: recipe.identity,
        recipe,
      },
      setupAuthorized: true,
      snapshotStart: true,
      revalidateRepositorySource: revalidate,
      prepareRepositoryGitPack: ({ temporaryRoot, signal }) =>
        prepareWorkerWorkspaceGitPack({
          root: f.repository,
          baseCommit: latest.baseCommit,
          temporaryRoot,
          signal,
        }),
      requireCurrent() {},
    });
    f.upload.mockClear();
    f.runScript.mockClear();
    try {
      const prepared = await owner.project.prepare({
        ...f,
        snapshotBaseCommit: f.project.baseCommit,
      });
      expect(prepared.baseCommit).toBe(f.project.baseCommit);
      expect(prepared.cacheHit).toBe(true);
      expect(f.upload).not.toHaveBeenCalled();
      expect(f.runScript).toHaveBeenCalledOnce();
      expect(revalidate).toHaveBeenCalledOnce();
      expect(await requireGit(workspace.workspaceDir, ["rev-parse", "HEAD"])).toBe(
        f.project.baseCommit,
      );
      expect(await readText(workspace.homeDir, "setup-count")).toBe("setup\n");
      await owner.project.inspectPreparedWorkspace!({
        runScript: f.runScript,
        baseCommit: f.project.baseCommit,
      });
      expect(owner.getPreparedWorkspace()?.baseCommit).toBe(f.project.baseCommit);
    } finally {
      owner.close();
    }
  });
});
