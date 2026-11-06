import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import {
  createWorkerProjectPreparation,
  readWorkerProjectEnvironmentRecipe,
} from "./project-preparation.js";
import {
  createProjectPreparationFixture,
  runProjectScriptWithGitProbe,
} from "./project-preparation.test-support.js";
import { prepareWorkerProjectSnapshot } from "./workspace-git-base.js";
import { parseWorkerWorkspaceManifest } from "./workspace-manifest.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const readText = (root: string, file: string) => fs.readFile(path.join(root, file), "utf8");
const manifests = (home: string) => path.join(home, ".openclaw-worker", "manifests", "prepared");

function fixture(setup?: string) {
  return createProjectPreparationFixture(tempDirs.make("project-verification-"), setup);
}

async function advanceProject(repository: string) {
  await fs.writeFile(path.join(repository, "input.txt"), "changed B\n");
  await requireGit(repository, ["commit", "--quiet", "-am", "B"]);
  return (await prepareWorkerProjectSnapshot({ localPath: repository, namespace: "gateway" }))!;
}

it("verifies transferred objects once and reuses completed worker objects with phase timings", async () => {
  const f = await fixture();
  let fscks = 0;
  f.runScript.mockImplementation((script) =>
    runProjectScriptWithGitProbe(script, f.home, (args) => {
      if (args.includes("fsck")) {
        fscks++;
      }
      return undefined;
    }),
  );
  for (const [project, expectedFscks] of [
    [f.project, 1],
    [f.project, 0],
    [await advanceProject(f.repository), 0],
  ] as const) {
    fscks = 0;
    const operation = await f.preparedOperation(undefined, { project });
    try {
      const result = await operation.project.prepare(f);
      expect.soft(fscks).toBe(expectedFscks);
      expect.soft(result.recipePreparation?.phaseDurationsMs).toMatchObject({
        inspection: expect.any(Number),
        seedVerification: expect.any(Number),
      });
      for (const duration of Object.values(result.recipePreparation?.phaseDurationsMs ?? {})) {
        expect(Number.isSafeInteger(duration) && duration >= 0).toBe(true);
      }
    } finally {
      operation.close();
    }
  }
});

it.each(["absent", "skipped"] as const)(
  "completes seed transfer without setup authority (%s recipe)",
  async (recipe) => {
    const f = await fixture(
      recipe === "skipped" ? '#!/bin/sh\nprintf unexpected > "$HOME/setup-ran"\n' : undefined,
    );
    const setupRecipe = (await readWorkerProjectEnvironmentRecipe(f.project)).identity;
    expect(Boolean(setupRecipe)).toBe(recipe === "skipped");
    const prepare = async (project: typeof f.project, key: string, text: string, uploads = 1) => {
      const operation = createWorkerProjectPreparation({
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
      expect(operation.getPreparedWorkspace()).toBeUndefined();
      const result = await operation.project.prepare(f);
      operation.close();
      expect(result).toMatchObject({
        captureRequired: true,
        recipePreparation: { source: recipe === "skipped" ? "script" : "none" },
      });
      expect(f.runScript).toHaveBeenCalledTimes(2);
      expect(f.upload).toHaveBeenCalledTimes(uploads);
      const prepared = result.preparedWorkspace!;
      expect(await readText(prepared.workspaceDir, "input.txt")).toBe(text);
      await expect(fs.stat(path.join(prepared.homeDir, "setup-ran"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      return prepared;
    };
    const prepared = await prepare(f.project, "a".repeat(64), "prepared base\n", 1);
    expect(prepared.preparedManifestRef).toBe(prepared.sourceManifestRef);
    const completion = await readText(
      manifests(prepared.homeDir),
      `${prepared.sourceManifestRef.slice(7)}/${prepared.preparedManifestRef.slice(7)}.json`,
    );
    expect(parseWorkerWorkspaceManifest(completion, prepared.preparedManifestRef).baseCommit).toBe(
      f.project.baseCommit,
    );
    const project = await advanceProject(f.repository);
    f.runScript.mockClear();
    const refreshed = await prepare(project, "b".repeat(64), "changed B\n", 2);
    expect(refreshed).toMatchObject({
      workspaceDir: prepared.workspaceDir,
      homeDir: prepared.homeDir,
    });
    expect(await requireGit(prepared.workspaceDir, ["rev-parse", "HEAD"])).toBe(project.baseCommit);
  },
);

it.each(["removed", "HEAD", "completion", "standalone", "appeared"] as const)(
  "rejects a workspace whose %s identity changes after inspection",
  async (changed) => {
    const f = await fixture();
    const first = changed === "appeared" ? f.operation() : await f.preparedOperation();
    const prepared = (await first.project.prepare(f)).preparedWorkspace!;
    first.close();
    const project = changed === "appeared" ? f.project : await advanceProject(f.repository);
    const next =
      changed === "appeared"
        ? await f.preparedOperation()
        : await f.preparedOperation(undefined, { project, key: "b".repeat(64) });
    let calls = 0;
    const runScript = async (script: string) => {
      calls++;
      const result = await f.runScript(script);
      if (changed === "appeared") {
        const replacement = await f.preparedOperation();
        await replacement.project.prepare(f);
        replacement.close();
      } else if (calls === 1) {
        const workspace = prepared.workspaceDir;
        const git = (...args: string[]) => requireGit(workspace, args);
        if (changed === "removed") {
          await fs.rename(path.dirname(workspace), path.join(f.home, "retired"));
        } else if (changed === "HEAD") {
          await git("fetch", "--depth=1", "--update-shallow", f.repository, project.baseCommit);
          await git("checkout", "--detach", project.baseCommit);
        } else if (changed === "completion") {
          const completionRoot = manifests(prepared.homeDir);
          await fs.rename(
            path.join(completionRoot, prepared.sourceManifestRef.slice(7)),
            path.join(completionRoot, "0".repeat(64)),
          );
        } else {
          await fs.writeFile(
            path.join(workspace, ".git/objects/info/alternates"),
            `${path.join(f.repository, ".git", "objects")}\n`,
          );
        }
      }
      return result;
    };
    await expect(
      next.project.prepare({
        ...f,
        runScript,
        runScriptWithBudget: (createScript) => runScript(createScript(30_000)),
      }),
    ).rejects.toThrow(
      changed === "standalone" ? "Git base is not standalone" : "changed during preparation",
    );
    next.close();
    if (changed !== "appeared") {
      expect(calls).toBe(2);
    }
    expect(next.getPreparedWorkspace()).toBeUndefined();
  },
);

it("requires a budgeted transport before transferring a new prepared workspace", async () => {
  const f = await fixture();
  const operation = await f.preparedOperation();
  await expect(
    operation.project.prepare({ runScript: f.runScript, upload: f.upload }),
  ).rejects.toThrow("Prepared workspaces require a provider command budget");
  operation.close();
  expect(f.runScript).not.toHaveBeenCalled();
  expect(f.upload).not.toHaveBeenCalled();
});

it("requires administrator authority for a pinned setup and rechecks the owner after seed installation", async () => {
  const f = await fixture('#!/bin/sh\nprintf setup > "$HOME/count"\n');
  const setupRecipe = (await readWorkerProjectEnvironmentRecipe(f.project)).identity;
  expect(setupRecipe).toMatch(/^[a-f0-9]{40}$/u);
  expect(() =>
    createWorkerProjectPreparation({
      project: f.project,
      namespace: "gateway",
      preparation: {
        purpose: "session",
        demandAtMs: 1_000,
        key: "a".repeat(64),
        cacheKey: "c".repeat(64),
        setupRecipe,
      },
      requireCurrent: () => {},
    }),
  ).toThrow("operator.admin");
  const seed = f.operation();
  await seed.project.prepare(f);
  seed.close();
  let current = true;
  const prepared = await f.preparedOperation(() => {
    if (!current) {
      throw new Error("owner replaced");
    }
  });
  await expect(
    prepared.project.prepare({
      upload: f.upload,
      runScriptWithBudget: (createScript) => f.runScriptWithBudget(createScript),
      runScript: async (script) => {
        const output = await f.runScript(script);
        current = false;
        return output;
      },
    }),
  ).rejects.toThrow("owner replaced");
  prepared.close();
  expect(
    await fs.stat(path.join(f.home, ".openclaw-worker", "prepared")).catch(() => undefined),
  ).toBeUndefined();
});
