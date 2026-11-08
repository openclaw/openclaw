import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { deleteRegistryWorktree } from "../../agents/worktrees/registry.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { gitNullConfigPath } from "../../infra/git-exec.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { acknowledgeLocalWorkspaceConflict } from "./local-workspace-conflict-acknowledgement.js";
import { synchronizeResolvedCanonicalPaths } from "./local-workspace-conflict-resolution.js";
import { withLocalWorkspaceProjection } from "./local-workspace-projection.js";
import { withLocalWorkspaceStore } from "./local-workspace-store.js";
import { readLocalWorkspaceProjection } from "./local-workspace-store.test-support.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";

let root: string;
let stateRoot: string;
let repo: string;
let canonical: string;
let owner: LocalWorkspaceOwner;
const git = (cwd: string, ...args: string[]) => requireGit(cwd, args);
const readText = (directory: string, ...parts: string[]) =>
  fs.readFile(path.join(directory, ...parts), "utf8");
const prepare = () => withLocalWorkspaceProjection(owner, (state) => state.prepare());
const synchronize = () =>
  withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
const settleProjection = () => withLocalWorkspaceProjection(owner, (state) => state.settle());
const readProjection = () => readLocalWorkspaceProjection(owner.worktree.id);
const writeText = (directory: string, relative: string, data: string) =>
  fs.writeFile(path.join(directory, relative), data);
async function expectText(directory: string, relative: string, expected: string) {
  expect(await readText(directory, relative)).toBe(expected);
}
const acknowledge = (filePath: string) =>
  acknowledgeLocalWorkspaceConflict({
    cwd: canonical,
    worktreeId: owner.worktree.id,
    path: filePath,
  });

const suiteDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
beforeAll(() => {
  stateRoot = suiteDirs.make("openclaw-local-projection-conflict-state-");
  openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: stateRoot } });
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-local-projection-conflict-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateRoot);
  vi.stubEnv("GIT_CONFIG_GLOBAL", gitNullConfigPath());
  vi.stubEnv("GIT_CONFIG_SYSTEM", gitNullConfigPath());
  setRuntimeConfigSnapshot({});
  repo = path.join(root, "source");
  canonical = path.join(root, "canonical");
  await fs.mkdir(repo);
  await git(repo, "init", "--quiet", "-b", "main");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "user.email", "test@example.invalid");
  await writeText(repo, "source.txt", "original\n");
  await writeText(repo, "other.txt", "original other\n");
  await writeText(repo, ".gitignore", ".env.local\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "--quiet", "-m", "base");
  await git(repo, "worktree", "add", "--quiet", "-b", "openclaw/guest", canonical);
  await writeText(canonical, ".env.local", "host-only-secret\n");
  const sessionKey = `agent:main:dashboard:guest-${randomUUID()}`;
  owner = {
    agentId: "main",
    sessionKey,
    sessionId: randomUUID(),
    lifecycleRevision: null,
    assertCurrent: () => {},
    worktree: {
      id: randomUUID(),
      name: "guest",
      repoFingerprint: "test",
      repoRoot: repo,
      path: canonical,
      branch: "openclaw/guest",
      baseRef: "main",
      ownerKind: "session",
      ownerId: sessionKey,
      createdAt: 0,
      lastActiveAt: 0,
    },
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await withLocalWorkspaceStore({ worktreeId: owner.worktree.id }, async (store) => {
    let row = store.get();
    if (row) {
      if (row.pending_ref || row.journal_json) {
        row = await store.update(row, { pending_ref: null, journal_json: null });
      }
      await store.delete(row);
      await fs.rm(path.dirname(row.projection_path), { recursive: true, force: true });
    }
  });
  await deleteRegistryWorktree(process.env, owner.worktree.id);
  if (process.env.OPENCLAW_STATE_DIR !== stateRoot) {
    await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath());
  }
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

it("admits a reconciled third version combining human and guest edits after a conflict", async () => {
  const projection = await prepare();
  await writeText(projection, "source.txt", "guest contribution\n");
  await writeText(canonical, "source.txt", "human contribution\n");
  await expect(synchronize()).rejects.toThrow("conflict");
  expect((await readProjection())?.pending_ref).toBeTruthy();
  await expectText(canonical, "source.txt", "human contribution\n");
  await expectText(projection, "source.txt", "guest contribution\n");

  // An unacknowledged ordinary disk change must not silently discard the guest contribution (Finding 3)
  await writeText(canonical, "source.txt", "unacknowledged background edit\n");
  await expect(settleProjection()).rejects.toThrow("conflict");
  expect((await readProjection())?.pending_ref).toBeTruthy();

  // Administrator writes a third merged version and explicitly acknowledges resolution
  await writeText(canonical, "source.txt", "merged human and guest contribution\n");
  await acknowledge("source.txt");
  await settleProjection();
  expect((await readProjection())?.pending_ref).toBeNull();
  await prepare();
  await expectText(canonical, "source.txt", "merged human and guest contribution\n");
  await expectText(projection, "source.txt", "merged human and guest contribution\n");
});

it("recovers a retained conflict across restart and admits a merged resolution", async () => {
  const projection = await prepare();
  await writeText(projection, "source.txt", "guest task work\n");
  await writeText(canonical, "source.txt", "coordinator instructions\n");
  await expect(synchronize()).rejects.toThrow("conflict");
  expect((await readProjection())?.pending_ref).toBeTruthy();

  // Simulate gateway restart
  await closeOpenClawStateDatabaseAsync();
  await expect(settleProjection()).rejects.toThrow("conflict");
  expect((await readProjection())?.pending_ref).toBeTruthy();

  // Reconciled third version combining work with explicit acknowledgement
  await writeText(canonical, "source.txt", "coordinator instructions + guest task work\n");
  await acknowledge("source.txt");
  await settleProjection();
  expect((await readProjection())?.pending_ref).toBeNull();
  await prepare();
  await expectText(canonical, "source.txt", "coordinator instructions + guest task work\n");
  await expectText(projection, "source.txt", "coordinator instructions + guest task work\n");
});

it("retains completed partial resolutions while other conflicts remain across retries (Finding 4)", async () => {
  const projection = await prepare();
  await writeText(projection, "source.txt", "guest source\n");
  await writeText(canonical, "source.txt", "human source\n");
  await writeText(projection, "other.txt", "guest other\n");
  await writeText(canonical, "other.txt", "human other\n");
  await expect(synchronize()).rejects.toThrow("conflict");
  expect((await readProjection())?.pending_ref).toBeTruthy();

  // Partially resolve only source.txt; other.txt remains conflicted
  await writeText(canonical, "source.txt", "merged source\n");
  await acknowledge("source.txt");

  // Settle must synchronize source.txt but still reject because other.txt is conflicted
  await expect(settleProjection()).rejects.toThrow("conflict");
  await expectText(projection, "source.txt", "merged source\n");
  await expectText(canonical, "source.txt", "merged source\n");

  // On next retry, source.txt must NOT re-conflict (partial resolution preserved)
  await expect(settleProjection()).rejects.toThrow("conflict");

  // Now resolve other.txt
  await writeText(canonical, "other.txt", "merged other\n");
  await acknowledge("other.txt");
  await settleProjection();
  expect((await readProjection())?.pending_ref).toBeNull();
  await prepare();
  await expectText(canonical, "source.txt", "merged source\n");
  await expectText(projection, "source.txt", "merged source\n");
  await expectText(canonical, "other.txt", "merged other\n");
  await expectText(projection, "other.txt", "merged other\n");
});

it("preserves checkpoint format for receipts without initial checkpoint_json (Finding 5)", async () => {
  const projection = await prepare();
  await writeText(projection, "source.txt", "guest work\n");
  await writeText(canonical, "source.txt", "human work\n");
  await expect(synchronize()).rejects.toThrow("conflict");

  // Strip checkpoint_json to simulate legacy / base-refresh receipt
  await withLocalWorkspaceStore({ worktreeId: owner.worktree.id }, async (store) => {
    const row = store.get();
    if (row) {
      await store.update(row, { checkpoint_json: null });
    }
  });

  // Reconcile source.txt with acknowledgement
  await writeText(canonical, "source.txt", "resolved work\n");
  await acknowledge("source.txt");

  // Settlement must not throw "Local workspace checkpoint no longer matches its baseline"
  await settleProjection();
  expect((await readProjection())?.pending_ref).toBeNull();
  await prepare();
  await expectText(canonical, "source.txt", "resolved work\n");
  await expectText(projection, "source.txt", "resolved work\n");
});

it("excludes unadmitted host-only files (.env.local) from entering the projection (Finding 1)", async () => {
  const projection = await prepare();
  await writeText(projection, "source.txt", "guest edit\n");
  await writeText(canonical, "source.txt", "human edit\n");
  await expect(synchronize()).rejects.toThrow("conflict");

  // Save changes to host-only ignored file .env.local during active conflict
  await writeText(canonical, ".env.local", "MUTATED_SECRET=value\n");
  await acknowledge(".env.local");

  // Resolve the actual admitted conflict
  await writeText(canonical, "source.txt", "resolved edit\n");
  await acknowledge("source.txt");
  await settleProjection();

  // .env.local must NOT have been imported into the guest projection
  const projectionEnvExists = await fs
    .stat(path.join(projection, ".env.local"))
    .then(() => true)
    .catch(() => false);
  expect(projectionEnvExists).toBe(false);
  await expectText(canonical, ".env.local", "MUTATED_SECRET=value\n");
});

it("replaces projection symlinks safely without following destination links (Finding 2)", async () => {
  const projection = await prepare();
  await writeText(projection, "target.txt", "target content\n");
  // Guest creates a symlink in projection
  await fs.unlink(path.join(projection, "source.txt"));
  await fs.symlink("target.txt", path.join(projection, "source.txt"));
  await writeText(canonical, "source.txt", "human canonical content\n");
  await expect(synchronize()).rejects.toThrow("conflict");

  // Administrator resolves source.txt
  await writeText(canonical, "source.txt", "resolved regular file\n");
  await acknowledge("source.txt");
  await settleProjection();

  // Destination symlink in projection must be replaced by the regular file, not follow it
  const projectionSourceStat = await fs.lstat(path.join(projection, "source.txt"));
  expect(projectionSourceStat.isSymbolicLink()).toBe(false);
  expect(projectionSourceStat.isFile()).toBe(true);
  await expectText(projection, "source.txt", "resolved regular file\n");
  await expectText(projection, "target.txt", "target content\n");
});

it("overlays resolved paths onto complete accepted baseline preserving unmutated baseline entries (Finding 3)", async () => {
  const projection = await prepare();
  await writeText(projection, "source.txt", "guest source edit\n");
  await writeText(canonical, "source.txt", "human source edit\n");
  await expect(synchronize()).rejects.toThrow("conflict");

  // Reconcile and acknowledge source.txt; other.txt was never touched during conflict
  await writeText(canonical, "source.txt", "reconciled source\n");
  await acknowledge("source.txt");
  await settleProjection();
  expect((await readProjection())?.pending_ref).toBeNull();

  // Subsequent prepare must verify both source.txt and unmutated other.txt exist intact
  await prepare();
  await expectText(canonical, "source.txt", "reconciled source\n");
  await expectText(projection, "source.txt", "reconciled source\n");
  await expectText(canonical, "other.txt", "original other\n");
  await expectText(projection, "other.txt", "original other\n");
});

it("preserves newer guest divergence in projection if edited while conflict is pending (Finding 5)", async () => {
  const projection = await prepare();
  await writeText(projection, "source.txt", "guest v1\n");
  await writeText(canonical, "source.txt", "canonical v1\n");
  await expect(synchronize()).rejects.toThrow("conflict");

  // A background process in the guest projection makes newer edits
  await writeText(projection, "source.txt", "guest v2 newer divergence\n");

  // Canonical acknowledges resolution to canonical v1
  await acknowledge("source.txt");
  await expect(settleProjection()).rejects.toThrow("conflict");

  // Live guest divergence in projection must NOT be overwritten
  await expectText(projection, "source.txt", "guest v2 newer divergence\n");
  expect((await readProjection())?.pending_ref).toBeTruthy();
});

it("allows explicitly accepted Markdown separator lines (Revision 3 Finding 1)", async () => {
  const projection = await prepare();
  // Concurrent edit with markdown separator in canonical
  await writeText(projection, "source.txt", "Guest Handover\n");
  await writeText(canonical, "source.txt", "Handover\n=======\nDetailed summary\n");
  await expect(synchronize()).rejects.toThrow("conflict");

  // Operator explicitly acknowledges source.txt containing '=======\n'
  await acknowledge("source.txt");
  await settleProjection();

  expect((await readProjection())?.pending_ref).toBeNull();
  await expectText(projection, "source.txt", "Handover\n=======\nDetailed summary\n");
});

it("refuses to resolve when an ancestor directory component is a symlink (Revision 3 Finding 2)", async () => {
  const projection = await prepare();
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-outside-"));

  // Guest creates sub as a symlink pointing outside
  await fs.symlink(outsideDir, path.join(projection, "sub"));

  // Canonical has a file at sub/deep/file.txt
  await fs.mkdir(path.join(canonical, "sub", "deep"), { recursive: true });
  await writeText(canonical, path.join("sub", "deep", "file.txt"), "canonical content\n");

  // synchronizeResolvedCanonicalPaths must throw because ancestor component 'sub' escapes projection root
  await expect(
    synchronizeResolvedCanonicalPaths({
      canonicalRoot: canonical,
      projectionRoot: projection,
      resolvedPaths: ["sub/deep/file.txt"],
    }),
  ).rejects.toThrow(/escapes projection root|ancestor is a symlink/);

  // Guest creates internal_target directory and links internal_sub -> internal_target
  await fs.mkdir(path.join(projection, "internal_target"), { recursive: true });
  await fs.symlink("internal_target", path.join(projection, "internal_sub"));
  await fs.mkdir(path.join(canonical, "internal_sub", "deep"), { recursive: true });
  await writeText(canonical, path.join("internal_sub", "deep", "file.txt"), "canonical internal\n");

  // synchronizeResolvedCanonicalPaths must throw specifically because internal ancestor is a symlink
  await expect(
    synchronizeResolvedCanonicalPaths({
      canonicalRoot: canonical,
      projectionRoot: projection,
      resolvedPaths: ["internal_sub/deep/file.txt"],
    }),
  ).rejects.toThrow(/ancestor is a symlink/);

  await fs.rm(outsideDir, { recursive: true, force: true });
});

it("preserves live guest symlink divergence across retries (Revision 3 Finding 4)", async () => {
  const projection = await prepare();
  // Guest creates a symlink target
  await writeText(projection, "target1.txt", "target 1\n");
  await writeText(projection, "target2.txt", "target 2\n");
  await fs.unlink(path.join(projection, "source.txt"));
  await fs.symlink("target1.txt", path.join(projection, "source.txt"));

  await writeText(canonical, "source.txt", "canonical v1\n");
  await expect(synchronize()).rejects.toThrow("conflict");

  // Guest concurrently changes the symlink target to target2.txt
  await fs.unlink(path.join(projection, "source.txt"));
  await fs.symlink("target2.txt", path.join(projection, "source.txt"));

  // Canonical acknowledges resolution
  await acknowledge("source.txt");
  await expect(settleProjection()).rejects.toThrow("conflict");

  // Live guest symlink must NOT be overwritten
  const stat = await fs.lstat(path.join(projection, "source.txt"));
  expect(stat.isSymbolicLink()).toBe(true);
  expect(await fs.readlink(path.join(projection, "source.txt"))).toBe("target2.txt");
});
