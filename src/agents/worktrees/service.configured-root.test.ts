import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { ManagedWorktreeService, IDLE_GC_MS } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";

describe("configured managed worktree root", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  let root: string;
  let repo: string;
  let stateDir: string;
  let worktreeRoot: string | undefined;
  let now: number;
  let service: ManagedWorktreeService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worktree-root-"));
    repo = await initializeRepository(root);
    stateDir = path.join(root, "state");
    worktreeRoot = undefined;
    now = Date.now();
    service = new ManagedWorktreeService({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      now: () => now,
      getConfig: () => ({ worktreeRoot }),
    });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reuses, snapshots, and restores recorded paths when the new root is unavailable", async () => {
    const manual = await service.create({ repoRoot: repo, name: "manual", baseRef: "HEAD" });
    const owner = {
      repoRoot: repo,
      baseRef: "HEAD",
      ownerKind: "session" as const,
      ownerId: "owner",
    };
    const session = await service.create({ ...owner, name: "session" });
    await fs.writeFile(path.join(manual.path, "README.md"), "preserved edit\n");
    await fs.writeFile(path.join(manual.path, "untracked.txt"), "preserved untracked\n");
    worktreeRoot = path.join(root, "unavailable-root");
    await fs.writeFile(worktreeRoot, "a file is not a worktree directory\n");

    expect((await service.create({ repoRoot: repo, name: "manual", baseRef: "HEAD" })).id).toBe(
      manual.id,
    );
    expect((await service.create({ ...owner, name: "another-title" })).id).toBe(session.id);
    await service.remove({ id: manual.id, reason: "root-change" });
    const restoredByName = await service.create({
      repoRoot: repo,
      name: "manual",
      baseRef: "HEAD",
    });
    expect(restoredByName.id).toBe(manual.id);
    expect(restoredByName.path).toBe(manual.path);
    await service.remove({ id: manual.id, reason: "root-change-again" });
    const restoredById = await service.restore({ id: manual.id });
    expect(restoredById.path).toBe(manual.path);
    expect(await fs.readFile(path.join(manual.path, "README.md"), "utf8")).toBe("preserved edit\n");
    expect(await fs.readFile(path.join(manual.path, "untracked.txt"), "utf8")).toBe(
      "preserved untracked\n",
    );
  });

  it("cleans registered work across roots and preserves unregistered custom-root contents", async () => {
    const owner = {
      repoRoot: repo,
      baseRef: "HEAD",
      ownerKind: "session" as const,
      ownerId: "old-owner",
    };
    const original = await service.create({ ...owner, name: "same-title" });
    await service.remove({ id: original.id, reason: "before-root-change" });
    worktreeRoot = path.join(root, "custom");
    const successor = await service.create({ ...owner, suggestedName: "same-title" });
    expect(successor.name).toBe("same-title-2");
    expect(successor.path).toBe(path.join(worktreeRoot, successor.repoFingerprint, successor.name));
    const restored = await service.restore({ id: original.id });
    const unrelated = path.join(
      worktreeRoot,
      successor.repoFingerprint,
      "unregistered",
      "keep.txt",
    );
    await fs.mkdir(path.dirname(unrelated), { recursive: true });
    await fs.writeFile(unrelated, "unrelated data\n");
    now = Math.max(restored.lastActiveAt, successor.lastActiveAt) + IDLE_GC_MS + 1;

    const result = await service.gc();
    expect(result.removed.toSorted()).toEqual([original.id, successor.id].toSorted());
    expect(result.orphansDeleted).toBe(0);
    expect(await fs.readFile(unrelated, "utf8")).toBe("unrelated data\n");
    expect((await service.list()).every((record) => record.snapshotRef && record.removedAt)).toBe(
      true,
    );
    expect((await service.restore({ id: original.id })).path).toBe(original.path);
  });

  it.each(["deep", "symlink"])(
    "preserves %s custom-root contents during GC, including after a root change",
    async (kind) => {
      const nestedRoot = path.join(
        stateDir,
        "worktrees",
        "custom",
        ...(kind === "deep" ? ["deeper"] : []),
      );
      await fs.mkdir(nestedRoot, { recursive: true });
      worktreeRoot = nestedRoot;
      if (kind === "symlink") {
        worktreeRoot = path.join(root, "linked-nested-root");
        await fs.symlink(
          nestedRoot,
          worktreeRoot,
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      const unrelated = path.join(nestedRoot, "unregistered", "keep.txt");
      await fs.mkdir(path.dirname(unrelated));
      await fs.writeFile(unrelated, "unrelated data\n");
      expect((await service.gc()).orphansDeleted).toBe(0);
      expect(await fs.readFile(unrelated, "utf8")).toBe("unrelated data\n");

      const record = await service.create({ repoRoot: repo, name: "nested", baseRef: "HEAD" });
      expect(record.path).toBe(path.join(nestedRoot, record.repoFingerprint, record.name));
      await fs.writeFile(path.join(record.path, "README.md"), "unsnapshotted edit\n");
      for (const nextRoot of [worktreeRoot, path.join(root, "next-root")]) {
        worktreeRoot = nextRoot;
        expect((await service.gc()).orphansDeleted).toBe(0);
        expect(await fs.readFile(path.join(record.path, "README.md"), "utf8")).toBe(
          "unsnapshotted edit\n",
        );
        expect(await fs.readFile(unrelated, "utf8")).toBe("unrelated data\n");
        expect(
          (await service.list()).find((entry) => entry.id === record.id)?.removedAt,
        ).toBeUndefined();
      }
    },
  );
});
