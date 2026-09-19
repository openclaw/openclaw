import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as commandExec from "../../process/exec.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import * as stateLease from "../../state/openclaw-state-lease.js";
import { requireGit, runGit } from "./git.js";
import { getRegistryWorktree } from "./registry.js";
import { ManagedWorktreeService, SNAPSHOT_RETENTION_MS } from "./service.js";

const identity = {
  GIT_AUTHOR_NAME: "OpenClaw Test",
  GIT_AUTHOR_EMAIL: "openclaw-test@example.invalid",
  GIT_COMMITTER_NAME: "OpenClaw Test",
  GIT_COMMITTER_EMAIL: "openclaw-test@example.invalid",
};

describe("empty managed workspaces", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    }),
  );
  let root: string;
  let env: NodeJS.ProcessEnv;
  let now: number;
  let service: ManagedWorktreeService;

  function create(name: string) {
    return service.createEmpty({ name, ownerKind: "session", ownerId: `agent:main:${name}` });
  }

  beforeEach(() => {
    root = tempDirs.make("openclaw-empty-workspace-");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_CONFIG_GLOBAL", os.devNull);
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    now = 1_700_000_000_000;
    service = new ManagedWorktreeService({
      env,
      now: () => now,
      getConfig: () => ({ worktreeAcceleration: false }),
    });
  });

  it("concurrently reuses one session workspace without operator Git configuration", async () => {
    const config = path.join(root, "operator.gitconfig");
    await fs.writeFile(
      config,
      "[init]\n\ttemplateDir = /missing/template\n[commit]\n\tgpgSign = true\n",
    );
    const bootstrapEnv = {
      ...env,
      GIT_CONFIG_GLOBAL: config,
      GIT_DIR: path.join(root, "unrelated.git"),
      GIT_INDEX_FILE: path.join(root, "unrelated.index"),
      GIT_DEFAULT_HASH: "sha256",
    };
    const records = await Promise.all(
      Array.from({ length: 3 }, () =>
        new ManagedWorktreeService({ env: bootstrapEnv }).createEmpty({
          ownerKind: "session",
          ownerId: "agent:main:same-session",
          name: "same-session",
        }),
      ),
    );
    expect(new Set(records.map((record) => record.id)).size).toBe(1);
    const { repoRoot: source, path: workspace } = records[0]!;
    expect(path.basename(source)).toBe("workspace");
    expect(await requireGit(source, ["branch", "--show-current"])).toBe("main");
    expect(await requireGit(source, ["rev-list", "--count", "main"])).toBe("1");
    expect(await requireGit(source, ["ls-tree", "-r", "main"])).toBe("");
    expect(await fs.readdir(workspace)).toEqual([".git"]);
    expect(await fs.readdir(path.dirname(source))).toEqual([path.basename(source)]);
    expect(fsSync.existsSync(bootstrapEnv.GIT_DIR)).toBe(false);
    expect(fsSync.existsSync(bootstrapEnv.GIT_INDEX_FILE)).toBe(false);
  });

  it("isolates files, history, remotes, and config while retaining snapshot recovery", async () => {
    const first = await create("first");
    await fs.writeFile(path.join(first.path, "notes.md"), "Committed task content\n");
    await requireGit(first.path, ["add", "notes.md"]);
    await requireGit(first.path, ["commit", "-m", "Task progress"], { env: identity });
    await requireGit(first.path, ["remote", "add", "origin", "https://example.invalid/first.git"]);
    await requireGit(first.path, ["config", "openclaw.taskMarker", "first"]);
    const attachment = Buffer.from([0, 1, 128, 255]);
    await fs.writeFile(path.join(first.path, "attachment.bin"), attachment);
    const removed = await service.remove({ id: first.id, reason: "archive" });
    expect(removed).toMatchObject({ removed: true, snapshotRef: expect.any(String) });
    expect(fsSync.existsSync(first.path)).toBe(false);

    const restored = await service.restore({ id: first.id });
    expect(await fs.readFile(path.join(restored.path, "notes.md"), "utf8")).toBe(
      "Committed task content\n",
    );
    expect(await fs.readFile(path.join(restored.path, "attachment.bin"))).toEqual(attachment);
    const second = await create("second");
    expect(second.repoRoot).not.toBe(first.repoRoot);
    expect(await fs.readdir(second.path)).toEqual([".git"]);
    expect(await requireGit(second.path, ["remote"])).toBe("");
    expect((await runGit(second.path, ["config", "openclaw.taskMarker"])).code).toBe(1);
    expect(await requireGit(second.path, ["rev-list", "--all", "--count"])).toBe("1");
    expect(await requireGit(first.repoRoot, ["rev-list", "--count", "main"])).toBe("1");
    expect(await create("first")).toMatchObject({ id: first.id, path: first.path });

    const records = service.listRegistryRecords();
    await fs.rename(first.repoRoot, `${first.repoRoot}-saved`);
    await expect(create("first")).rejects.toThrow("Empty workspace source is missing");
    expect(fsSync.existsSync(first.repoRoot)).toBe(false);
    expect(service.listRegistryRecords()).toEqual(records);
    expect(await fs.readFile(path.join(restored.path, "attachment.bin"))).toEqual(attachment);
  });

  it.each(["files", "head", "commit", "metadata"])(
    "preserves and refuses a source with modified %s",
    async (modified) => {
      const { repoRoot: source } = await create("modified");
      const marker = path.join(source, "keep.txt");
      if (modified === "files") {
        await fs.writeFile(marker, "keep this content\n");
      } else if (modified === "head") {
        await requireGit(source, ["checkout", "--detach"]);
      } else if (modified === "commit") {
        await requireGit(source, ["commit", "--allow-empty", "-m", "Changed source"], {
          env: identity,
        });
      } else {
        await fs.rename(path.join(source, ".git"), path.join(source, "saved-metadata"));
      }
      await expect(create("modified")).rejects.toThrow(
        "Empty workspace source is unavailable or modified",
      );
      if (modified === "files") {
        expect(await fs.readFile(marker, "utf8")).toBe("keep this content\n");
      } else if (modified === "head") {
        expect(await requireGit(source, ["branch", "--show-current"])).toBe("");
      } else if (modified === "commit") {
        expect(await requireGit(source, ["rev-list", "--count", "main"])).toBe("2");
      } else {
        expect(fsSync.existsSync(path.join(source, "saved-metadata", "HEAD"))).toBe(true);
        expect(fsSync.existsSync(path.join(source, ".git"))).toBe(false);
      }
    },
  );

  it("cleans unexposed bootstrap state when authority is revoked after Git initialization", async () => {
    const revoked = new Error("session creation no longer owns this request");
    let current = true;
    const execute = commandExec.runCommandWithTimeout;
    vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      const result = await execute(argv, options);
      if (argv.includes("update-ref")) {
        current = false;
      }
      return result;
    });
    await expect(
      service.createEmpty({
        ownerKind: "session",
        ownerId: "agent:main:revoked",
        commitGuard: () => {
          if (!current) {
            throw revoked;
          }
        },
      }),
    ).rejects.toBe(revoked);
    expect(
      await fs.readdir(path.join(env.OPENCLAW_STATE_DIR!, "worktree-sources", "empty")),
    ).toEqual([]);
  });

  it("expires source metadata only with its final retained snapshot record", async () => {
    const created = await create("retained");
    await fs.writeFile(path.join(created.path, "draft.txt"), "Restorable work\n");
    await service.remove({ id: created.id, reason: "archive" });
    now += SNAPSHOT_RETENTION_MS;
    expect((await service.gc()).snapshotsPruned).toBe(0);
    expect(fsSync.existsSync(created.repoRoot)).toBe(true);
    const restored = await service.restore({ id: created.id });
    expect(await fs.readFile(path.join(restored.path, "draft.txt"), "utf8")).toBe(
      "Restorable work\n",
    );
    await service.remove({ id: created.id, reason: "archive-again" });
    now += SNAPSHOT_RETENTION_MS + 1;
    const unavailableLease = vi
      .spyOn(stateLease, "withOpenClawStateLease")
      .mockRejectedValue(new Error("allocation lease unavailable"));
    expect((await service.gc()).snapshotsPruned).toBe(0);
    expect(fsSync.existsSync(created.repoRoot)).toBe(true);
    const retained = getRegistryWorktree(env, created.id);
    expect(retained?.snapshotRef).toBeDefined();
    expect(await requireGit(created.repoRoot, ["show", `${retained!.snapshotRef}:draft.txt`])).toBe(
      "Restorable work",
    );
    unavailableLease.mockRestore();
    expect((await service.gc()).snapshotsPruned).toBe(1);
    expect(fsSync.existsSync(created.repoRoot)).toBe(false);
    expect(fsSync.existsSync(path.dirname(created.repoRoot))).toBe(false);
    expect(getRegistryWorktree(env, created.id)).toBeUndefined();
  });

  it("removes an unbound source when checkout allocation fails", async () => {
    await expect(create("invalid name")).rejects.toThrow("worktree name must match");
    expect(service.listRegistryRecords()).toEqual([]);
    expect(
      await fs.readdir(path.join(env.OPENCLAW_STATE_DIR!, "worktree-sources", "empty")),
    ).toEqual([]);
  });

  it("preserves an expired source with extra files and retries after they are moved", async () => {
    const created = await create("source-files");
    await service.remove({ id: created.id, reason: "archive" });
    const marker = path.join(created.repoRoot, "keep.txt");
    await fs.writeFile(marker, "Keep this unowned source file\n");
    now += SNAPSHOT_RETENTION_MS + 1;
    expect((await service.gc()).snapshotsPruned).toBe(0);
    expect(getRegistryWorktree(env, created.id)?.snapshotRef).toBeDefined();
    expect(await fs.readFile(marker, "utf8")).toBe("Keep this unowned source file\n");
    await fs.rename(marker, path.join(root, "saved.txt"));
    expect((await service.gc()).snapshotsPruned).toBe(1);
    expect(fsSync.existsSync(created.repoRoot)).toBe(false);
  });
});
