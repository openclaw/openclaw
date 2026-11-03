import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { insertRegistryWorktree } from "../agents/worktrees/registry.js";
import { getRegistryWorktree } from "../agents/worktrees/registry.test-support.js";
import { ManagedWorktreeService } from "../agents/worktrees/service.js";
import { initializeManagedWorktreeTestRepository } from "../agents/worktrees/service.test-support.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  detectLegacyStateMigrations,
  runLegacyStateMigrations,
} from "./state-migrations.doctor.js";

beforeEach(() => {
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    clearRuntimeConfigSnapshot();
    cleanup();
  });
});

function migrations(root: string, stateDir: string) {
  const env = { ...process.env, HOME: root, OPENCLAW_STATE_DIR: stateDir };
  const cfg = {};
  const common = { env, legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES };
  return {
    env,
    cfg,
    detect: () => detectLegacyStateMigrations({ ...common, cfg, homedir: () => root }),
    run: (detected: Awaited<ReturnType<typeof detectLegacyStateMigrations>>) =>
      runLegacyStateMigrations({ ...common, detected, config: cfg }),
  };
}

it("does not create the worktrees directory during detection", async () => {
  const root = tempDirs.make("openclaw-worktree-path-detection-");
  const stateDir = path.join(root, "state");
  await fs.mkdir(stateDir, { recursive: true });
  const detected = await migrations(root, stateDir).detect();

  expect(detected.worktrees.pathRewrites).toStrictEqual([]);
  await expect(fs.stat(path.join(stateDir, "worktrees"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.skipIf(process.platform === "win32")(
  "canonicalizes persisted paths when the latest additive worktree column is absent",
  async () => {
    const root = tempDirs.make("openclaw-worktree-path-migration-");
    const repo = await initializeManagedWorktreeTestRepository(root);
    const realStateDir = path.join(root, "real-state");
    const linkedStateDir = path.join(root, "linked-state");
    await fs.mkdir(realStateDir, { recursive: true });
    await fs.symlink(realStateDir, linkedStateDir, "dir");
    const { env, cfg, detect, run } = migrations(root, linkedStateDir);
    setRuntimeConfigSnapshot(cfg);
    const service = new ManagedWorktreeService({ env });
    const live = await service.create({ repoRoot: repo, name: "live", baseRef: "HEAD" });
    const canonicalRoot = path.dirname(path.dirname(live.path));
    const rawPath = (name: string) =>
      path.join(linkedStateDir, "worktrees", live.repoFingerprint, name);
    const { db, path: databasePath } = openOpenClawStateDatabase({ env });
    db.prepare("UPDATE worktrees SET path = ? WHERE id = ?").run(rawPath(live.name), live.id);
    const row = (name: string, pathname: string) => ({
      ...live,
      id: `${name}-row`,
      name,
      path: pathname,
      branch: `openclaw/${name}`,
    });
    const removed = { ...row("removed", rawPath("removed")), removedAt: 1 };
    const canonical = row("canonical", path.join(canonicalRoot, live.repoFingerprint, "canonical"));
    const movedPath = path.join(root, "relocated-worktrees", "moved");
    const moved = row("moved", movedPath);
    for (const entry of [removed, canonical, moved]) {
      await insertRegistryWorktree(env, entry, { provisionedPaths: [] });
    }

    await closeOpenClawStateDatabaseAsync();
    const { DatabaseSync } = requireNodeSqlite();
    {
      using beforeCleanupOutcome = new DatabaseSync(databasePath);
      beforeCleanupOutcome.exec("ALTER TABLE worktrees DROP COLUMN run_end_cleanup_json;");
    }

    // Doctor must accept the absent additive column before its read-only SELECT *.
    const detected = await detect();
    expect(detected.preview).toContain(
      "- Managed worktrees: canonicalize 2 persisted paths for symlinked state directories",
    );
    const result = await run(detected);
    expect(result.warnings).toStrictEqual([]);
    const change = "Canonicalized 2 managed worktree paths for symlinked state directories";
    expect(result.changes).toContain(change);
    const receipt = result.stepReceipts.find((entry) => entry.id === "managed-worktrees");
    expect(receipt).toMatchObject({
      source: [
        { kind: "sqlite", path: databasePath },
        ...[live.id, removed.id]
          .toSorted()
          .map((id) => ({ kind: "owner", id: `core:managed-worktree:${id}` })),
      ],
      outcome: "completed",
    });
    expect(
      [live, removed, canonical, moved].map(({ id }) => getRegistryWorktree(env, id)?.path),
    ).toEqual([
      live.path,
      path.join(canonicalRoot, live.repoFingerprint, removed.name),
      canonical.path,
      movedPath,
    ]);

    const secondDetection = await detect();
    expect(secondDetection.worktrees.pathRewrites).toStrictEqual([]);
    expect((await run(secondDetection)).changes).not.toContain(change);

    await service.acquire(live.id);
    await expect(service.removeIfLossless(live.id)).resolves.toBe(true);
    await expect(fs.stat(live.path)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
