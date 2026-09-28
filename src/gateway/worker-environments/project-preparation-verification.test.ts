import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import {
  createWorkerProjectPreparation,
  readWorkerProjectSetupRecipe,
} from "./project-preparation.js";
import { createProjectPreparationFixture } from "./project-preparation.test-support.js";
import { prepareWorkerProjectSnapshot } from "./workspace-git-base.js";
import { parseWorkerWorkspaceManifest } from "./workspace-manifest.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function fixture(setup?: string) {
  return createProjectPreparationFixture(tempDirs.make("project-verification-"), setup);
}

describe("prepared workspace completion and verification", () => {
  it.each(["absent", "skipped"] as const)(
    "completes a project whose recipe is %s in the seed transfer without setup authority",
    async (recipe) => {
      const f = await fixture(
        recipe === "skipped" ? '#!/bin/sh\nprintf unexpected > "$HOME/setup-ran"\n' : undefined,
      );
      const setupRecipe = await readWorkerProjectSetupRecipe(f.project);
      expect(Boolean(setupRecipe)).toBe(recipe === "skipped");
      const prepare = (project: typeof f.project, key: string) =>
        createWorkerProjectPreparation({
          project,
          namespace: "gateway",
          preparation: {
            purpose: "session",
            demandAtMs: 1_000,
            key,
            cacheKey: "c".repeat(64),
            setupRecipe,
            ...(recipe === "skipped" ? { runSetupScript: false } : {}),
          },
          requireCurrent: () => {},
        });
      const operation = prepare(f.project, "a".repeat(64));
      expect(operation.getPreparedWorkspace()).toBeUndefined();
      const result = await operation.project.prepare(f);
      operation.close();
      const prepared = result.preparedWorkspace!;
      expect(result.captureRequired).toBe(true);
      expect(f.runScript).toHaveBeenCalledTimes(2);
      expect(f.upload).toHaveBeenCalledTimes(1);
      expect(prepared.sourceManifestRef).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(prepared.preparedManifestRef).toBe(prepared.sourceManifestRef);
      expect(await fs.readFile(path.join(prepared.workspaceDir, "input.txt"), "utf8")).toBe(
        "prepared base\n",
      );
      const completion = path.join(
        prepared.homeDir,
        ".openclaw-worker",
        "manifests",
        "prepared",
        prepared.sourceManifestRef.slice(7),
        `${prepared.preparedManifestRef.slice(7)}.json`,
      );
      expect(
        parseWorkerWorkspaceManifest(
          await fs.readFile(completion, "utf8"),
          prepared.preparedManifestRef,
        ).baseCommit,
      ).toBe(f.project.baseCommit);
      await expect(fs.stat(path.join(prepared.homeDir, "setup-ran"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      await fs.writeFile(path.join(f.repository, "input.txt"), "changed B\n");
      await requireGit(f.repository, ["commit", "--quiet", "-am", "B"]);
      const project = (await prepareWorkerProjectSnapshot({
        localPath: f.repository,
        namespace: "gateway",
      }))!;
      f.runScript.mockClear();
      const next = prepare(project, "b".repeat(64));
      const refreshed = await next.project.prepare(f);
      next.close();
      expect(refreshed.captureRequired).toBe(true);
      expect(f.runScript).toHaveBeenCalledTimes(2);
      expect(f.upload).toHaveBeenCalledTimes(2);
      expect(refreshed.preparedWorkspace?.workspaceDir).toBe(prepared.workspaceDir);
      expect(refreshed.preparedWorkspace?.homeDir).toBe(prepared.homeDir);
      expect(await requireGit(prepared.workspaceDir, ["rev-parse", "HEAD"])).toBe(
        project.baseCommit,
      );
      expect(await fs.readFile(path.join(prepared.workspaceDir, "input.txt"), "utf8")).toBe(
        "changed B\n",
      );
      await expect(fs.stat(path.join(prepared.homeDir, "setup-ran"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.each(["removed", "HEAD", "completion", "standalone"])(
    "rejects a retained workspace whose %s identity changes before setup",
    async (changed) => {
      const f = await fixture();
      const first = await f.preparedOperation();
      const prepared = (await first.project.prepare(f)).preparedWorkspace!;
      first.close();
      await fs.writeFile(path.join(f.repository, "input.txt"), "changed B\n");
      await requireGit(f.repository, ["commit", "--quiet", "-am", "B"]);
      const b = (await prepareWorkerProjectSnapshot({
        localPath: f.repository,
        namespace: "gateway",
      }))!;
      const next = await f.preparedOperation(undefined, { project: b, key: "b".repeat(64) });
      let calls = 0;
      await expect(
        next.project.prepare({
          ...f,
          runScriptWithBudget: (createScript) => f.runScriptWithBudget(createScript),
          runScript: async (script) => {
            calls++;
            const result = await f.runScript(script);
            if (calls === 1) {
              if (changed === "removed") {
                await fs.rename(path.dirname(prepared.workspaceDir), path.join(f.home, "retired"));
              } else if (changed === "HEAD") {
                await requireGit(prepared.workspaceDir, [
                  "fetch",
                  "--depth=1",
                  "--update-shallow",
                  f.repository,
                  b.baseCommit,
                ]);
                await requireGit(prepared.workspaceDir, ["checkout", "--detach", b.baseCommit]);
              } else if (changed === "completion") {
                const completionRoot = path.join(
                  prepared.homeDir,
                  ".openclaw-worker",
                  "manifests",
                  "prepared",
                );
                await fs.rename(
                  path.join(completionRoot, prepared.sourceManifestRef.slice(7)),
                  path.join(completionRoot, "0".repeat(64)),
                );
              } else {
                await fs.writeFile(
                  path.join(prepared.workspaceDir, ".git", "objects", "info", "alternates"),
                  `${path.join(f.repository, ".git", "objects")}\n`,
                );
              }
            }
            return result;
          },
        }),
      ).rejects.toThrow(
        changed === "standalone" ? "Git base is not standalone" : "changed during preparation",
      );
      next.close();
      expect(calls).toBe(2);
      expect(next.getPreparedWorkspace()).toBeUndefined();
    },
  );

  it("does not adopt a prepared workspace that appeared after verifying its absence", async () => {
    const f = await fixture();
    const seed = f.operation();
    await seed.project.prepare(f);
    seed.close();
    const operation = await f.preparedOperation();
    await expect(
      operation.project.prepare({
        ...f,
        runScriptWithBudget: (createScript) => f.runScriptWithBudget(createScript),
        runScript: async (script) => {
          const result = await f.runScript(script);
          const replacement = await f.preparedOperation();
          await replacement.project.prepare(f);
          replacement.close();
          return result;
        },
      }),
    ).rejects.toThrow("changed during preparation");
    operation.close();
    expect(operation.getPreparedWorkspace()).toBeUndefined();
  });
});
