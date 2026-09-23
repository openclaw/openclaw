import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { createProjectPreparationFixture } from "./project-preparation.test-support.js";
import { prepareWorkerProjectSnapshot } from "./workspace-git-base.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function fixture() {
  return createProjectPreparationFixture(tempDirs.make("project-verification-"));
}

describe("prepared workspace verification lifetime", () => {
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
            const result = await f.runScript(script);
            if (++calls === 2) {
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
