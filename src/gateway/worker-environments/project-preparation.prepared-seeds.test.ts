import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { createWorkerProjectPreparation } from "./project-preparation.js";
import {
  createProjectPreparationFixture,
  runProjectScriptWithGitProbe,
} from "./project-preparation.test-support.js";
import type { RepositoryWorkerProjectSnapshot } from "./repository-project-source.schema.js";
import { prepareWorkerWorkspaceGitPack, workerProjectSeedKey } from "./workspace-git-base.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const origin = "https://ghe.example.test/acme/prepared.git";
const preparation = {
  key: "a".repeat(64),
  cacheKey: "b".repeat(64),
  purpose: "session" as const,
  demandAtMs: 1,
};

async function fixture() {
  const f = await createProjectPreparationFixture(tempDirs.make("prepared-image-seed-"));
  const originKey = createHash("sha256").update(origin).digest("hex");
  const donor = path.join(f.home, ".openclaw-worker", "prepared-git-seeds", originKey);
  await fs.cp(f.repository, donor, { recursive: true });
  await requireGit(donor, ["remote", "add", "origin", origin]);
  await fs.writeFile(path.join(donor, ".git", "hooks", "pre-checkout"), "exit 99\n");
  const inventory = path.join(f.home, "repositories.json");
  const row = {
    origin,
    key: originKey,
    commit: f.project.baseCommit,
    sourceRef: "refs/image/producer-only",
    bundleSha256: "d".repeat(64),
  };
  await fs.writeFile(inventory, JSON.stringify([row]));
  const project: RepositoryWorkerProjectSnapshot = {
    key: f.project.key,
    baseCommit: f.project.baseCommit,
    source: {
      kind: "repository",
      url: origin,
      repositoryId: "R_synthetic_seed",
      owner: {
        agent: { agentId: "main", provenance: null },
        identity: { source: "anonymous" },
      },
    },
  };
  const revalidate = vi.fn(async () => {});
  const preparePack = vi.fn(async (input: { temporaryRoot: string; signal: AbortSignal }) =>
    prepareWorkerWorkspaceGitPack({
      root: f.repository,
      baseCommit: project.baseCommit,
      ...input,
    }),
  );
  const runScript = vi.fn((script: string) =>
    runProjectScriptWithGitProbe(script, f.home, () => undefined, inventory),
  );
  const operation = (
    namespace = "first",
    requireCurrent = () => {},
    prepared?: Parameters<typeof createWorkerProjectPreparation>[0]["preparation"],
  ) =>
    createWorkerProjectPreparation({
      project,
      namespace,
      revalidateRepositorySource: revalidate,
      prepareRepositoryGitPack: preparePack,
      requireCurrent,
      preparation: prepared,
    });
  const seed = (namespace: string) =>
    path.join(f.home, ".openclaw-worker", "git-seeds", namespace, workerProjectSeedKey(project));
  return {
    ...f,
    donor,
    inventory,
    row,
    project,
    revalidate,
    preparePack,
    runScript,
    operation,
    seed,
  };
}

it("uses one image donor across admitted namespaces without copying Git authority or worktree edits", async () => {
  const f = await fixture();
  for (const namespace of ["first", "second"]) {
    const operation = f.operation(namespace);
    try {
      await expect(operation.project.prepare(f)).resolves.toMatchObject({
        seedKey: workerProjectSeedKey(f.project),
        cacheHit: true,
      });
      expect(await requireGit(f.seed(namespace), ["rev-parse", "HEAD"])).toBe(f.project.baseCommit);
      expect(await requireGit(f.seed(namespace), ["remote", "get-url", "origin"])).toBe(origin);
      expect(await requireGit(f.seed(namespace), ["status", "--porcelain"])).toBe("");
      expect(await requireGit(f.seed(namespace), ["config", "--local", "--list"])).not.toContain(
        "user.email",
      );
      expect(
        await fs.readdir(path.join(f.seed(namespace), ".git", "hooks")).catch(() => []),
      ).toEqual([]);
    } finally {
      operation.close();
    }
  }
  expect(f.revalidate).toHaveBeenCalledTimes(2);
  expect(f.preparePack).not.toHaveBeenCalled();
  expect(f.upload).not.toHaveBeenCalled();
  expect(await requireGit(f.donor, ["rev-parse", "HEAD"])).toBe(f.row.commit);
});

it.each(["missing", "older"])("uses the existing pack path for a valid %s donor", async (state) => {
  const f = await fixture();
  if (state === "missing") {
    await fs.rm(f.donor, { recursive: true });
  } else {
    await fs.writeFile(path.join(f.repository, "input.txt"), "new admitted commit\n");
    await requireGit(f.repository, ["commit", "--quiet", "-am", "new admitted base"]);
    f.project.baseCommit = await requireGit(f.repository, ["rev-parse", "HEAD"]);
  }
  const operation = f.operation();
  try {
    await expect(operation.project.prepare(f)).resolves.toMatchObject({ cacheHit: false });
    expect(f.preparePack).toHaveBeenCalledOnce();
    expect(f.upload).toHaveBeenCalledOnce();
    expect(await requireGit(f.seed("first"), ["rev-parse", "HEAD"])).toBe(f.project.baseCommit);
    expect(await requireGit(f.seed("first"), ["remote", "get-url", "origin"])).toBe(origin);
  } finally {
    operation.close();
  }
});

it.each(["origin", "inventory", "symlink", "corrupt", "alternates"])(
  "refuses a donor with unsafe %s before replacing an existing workspace",
  async (damage) => {
    const f = await fixture();
    const first = f.operation("first", undefined, preparation);
    const previous = (await first.project.prepare(f)).preparedWorkspace!.workspaceDir;
    first.close();
    // Retain the real completed workspace while its independently reusable seed is absent.
    await fs.rm(f.seed("first"), { recursive: true });
    if (damage === "origin") {
      await requireGit(f.donor, [
        "remote",
        "set-url",
        "origin",
        "https://ghe.example.test/other/repo.git",
      ]);
    } else if (damage === "inventory") {
      await fs.writeFile(f.inventory, JSON.stringify([{ ...f.row, commit: "a".repeat(40) }]));
    } else if (damage === "alternates") {
      await fs.writeFile(
        path.join(f.donor, ".git", "objects", "info", "alternates"),
        `${previous}/.git/objects\n`,
      );
    } else {
      const object = path.join(
        f.donor,
        ".git",
        "objects",
        f.row.commit.slice(0, 2),
        f.row.commit.slice(2),
      );
      await fs.rm(object);
      if (damage === "symlink") {
        await fs.symlink(
          path.join(
            f.repository,
            ".git",
            "objects",
            f.row.commit.slice(0, 2),
            f.row.commit.slice(2),
          ),
          object,
        );
      } else {
        await fs.writeFile(object, "corrupt object\n");
      }
    }
    const operation = f.operation("first", undefined, preparation);
    try {
      await expect(operation.project.prepare(f)).rejects.toThrow();
      expect(f.preparePack).not.toHaveBeenCalled();
      expect(f.upload).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(previous, "input.txt"), "utf8")).toBe("prepared base\n");
      expect(await requireGit(previous, ["rev-parse", "HEAD"])).toBe(f.row.commit);
      await expect(fs.stat(f.seed("first"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      operation.close();
    }
  },
);

it("denies donor acceptance after the original provisioning authority changes", async () => {
  const f = await fixture();
  let current = true;
  const operation = f.operation("first", () => {
    if (!current) {
      throw new Error("original owner replaced");
    }
  });
  try {
    await expect(
      operation.project.prepare({
        upload: f.upload,
        runScript: async (script) => {
          const result = await f.runScript(script);
          current = false;
          return result;
        },
      }),
    ).rejects.toThrow("original owner replaced");
    expect(operation.getPreparedWorkspace()).toBeUndefined();
    expect(operation.project.signal.aborted).toBe(true);
    expect(f.preparePack).not.toHaveBeenCalled();
    expect(f.upload).not.toHaveBeenCalled();
  } finally {
    operation.close();
  }
});

it("completes a donor seed through the existing budgeted prepared-workspace owner", async () => {
  const f = await fixture();
  const operation = createWorkerProjectPreparation({
    project: f.project,
    namespace: "first",
    preparation,
    revalidateRepositorySource: f.revalidate,
    prepareRepositoryGitPack: f.preparePack,
    requireCurrent: () => {},
  });
  try {
    const result = await operation.project.prepare(f);
    expect(result).toMatchObject({ cacheHit: true, captureRequired: true });
    const prepared = result.preparedWorkspace!;
    expect(await requireGit(prepared.workspaceDir, ["rev-parse", "HEAD"])).toBe(
      f.project.baseCommit,
    );
    expect(await requireGit(prepared.workspaceDir, ["remote", "get-url", "origin"])).toBe(origin);
    expect(f.runScript).toHaveBeenCalledTimes(2);
    expect(f.preparePack).not.toHaveBeenCalled();
    expect(f.upload).not.toHaveBeenCalled();
  } finally {
    operation.close();
  }
});
