import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { SandboxBackendHandle } from "../../agents/sandbox/backend-handle.types.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { deleteRegistryWorktree } from "../../agents/worktrees/registry.js";
import { getRegistryWorktree } from "../../agents/worktrees/registry.test-support.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import * as fsSafe from "../../infra/fs-safe.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { readLocalWorkspaceTree } from "./local-workspace-cas.kernel.js";
import {
  prepareLegacyArchiveRetention,
  proveAcceptedDirectoryRetention,
  proveLastFileDirectoryRetention,
} from "./local-workspace-directory-retention.test-support.js";
import {
  observeAcknowledgedUpdate,
  prepareLocalWorkspaceArchiveFixture,
  prepareSandboxCheckpointFixture,
  proveAbsentProjectionCheckpoints,
  proveHostAdmittedBuildInputs,
  proveInterruptedWorkspaceCheckpoint,
  proveIncrementalWorkspaceEdits,
  proveSandboxMutationCheckpoints,
  proveSharedSandboxCheckpoints,
  proveStagedInputCheckpointOwnership,
  proveWorkerOwnedIncrementalWorkspace,
} from "./local-workspace-incremental.test-support.js";
import { withLocalWorkspaceProjection } from "./local-workspace-projection.js";
import { withLocalWorkspaceStore } from "./local-workspace-store.js";
import {
  observeLocalWorkspaceStoreSql,
  readLocalWorkspaceProjection,
} from "./local-workspace-store.test-support.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";

let root: string;
let stateRoot: string;
let repo: string;
let canonical: string;
let owner: LocalWorkspaceOwner;
let revoked = false;
const git = (cwd: string, ...args: string[]) => requireGit(cwd, args);
const podmanFixture = createFixtureLifetime();
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
async function expectMissing(directory: string, ...parts: string[]) {
  await expect(fs.stat(path.join(directory, ...parts))).rejects.toMatchObject({ code: "ENOENT" });
}

const archiveFixture = (provisionedPaths: string[] = []) =>
  prepareLocalWorkspaceArchiveFixture(owner, provisionedPaths);
const treePaths = (tree: string) => git(repo, "ls-tree", "-r", "--name-only", tree);

const suiteDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
beforeAll(() => {
  stateRoot = suiteDirs.make("openclaw-local-projection-state-");
  openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: stateRoot } });
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-local-projection-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateRoot);
  vi.stubEnv("GIT_CONFIG_GLOBAL", os.devNull);
  vi.stubEnv("GIT_CONFIG_SYSTEM", os.devNull);
  setRuntimeConfigSnapshot({});
  repo = path.join(root, "source");
  canonical = path.join(root, "canonical");
  await fs.mkdir(repo);
  await git(repo, "init", "--quiet", "-b", "main");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "user.email", "test@example.invalid");
  await writeText(repo, "source.txt", "original\n");
  await writeText(repo, ".gitignore", ".env.local\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "--quiet", "-m", "base");
  await git(repo, "worktree", "add", "--quiet", "-b", "openclaw/guest", canonical);
  await writeText(canonical, ".env.local", "host-only-secret");
  await git(repo, "config", "credential.helper", "!echo host-credential");
  revoked = false;
  const sessionKey = `agent:main:dashboard:guest-${randomUUID()}`;
  owner = {
    agentId: "main",
    sessionKey,
    sessionId: randomUUID(),
    lifecycleRevision: null,
    assertCurrent: () => {
      if (revoked) {
        throw new Error("revoked");
      }
    },
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
  // Timeout unwinding still needs the engine environment and registry to remove containers.
  await podmanFixture.cleanup();
  // Retain the physical database and its reader worker; remove only this case's
  // ownership. The store refuses deletion while a receipt or journal is pending.
  revoked = false;
  vi.restoreAllMocks();
  await withLocalWorkspaceStore({ worktreeId: owner.worktree.id }, async (store) => {
    const row = store.get();
    if (row) {
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

it("checkpoints sandbox file writes once", () => proveSandboxMutationCheckpoints(owner));

it("avoids lease requests for absent projections and checkpoints a later projection", () =>
  proveAbsentProjectionCheckpoints(owner));

it("joins waiting sandbox checkpoints across handles without losing later writes", ({ signal }) =>
  proveSharedSandboxCheckpoints(owner, signal));

it.each([false, true])(
  "recovers an oversized artifact before sandbox preparation (EXDEV: %s)",
  async (crossDevice) => {
    await archiveFixture();
    if (crossDevice) {
      const openRoot = fsSafe.root;
      vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
        const stateFs = await openRoot(...args);
        const move = stateFs.move;
        stateFs.move = async (from, to, options) => {
          if (to.startsWith("workspace-recovery/")) {
            throw Object.assign(new Error("cross-device rename"), { code: "EXDEV" });
          }
          return await move(from, to, options);
        };
        return stateFs;
      });
    }
    const { proveOversizedWorkspaceRecovery } =
      await import("./local-workspace-recovery.test-support.js");
    await proveOversizedWorkspaceRecovery({ owner, canonical, stateRoot });
  },
);

it("recovers an aggregate payload of individually valid artifacts without losing edits", async () => {
  await archiveFixture();
  const { proveAggregateWorkspaceRecovery } =
    await import("./local-workspace-recovery.test-support.js");
  await proveAggregateWorkspaceRecovery({ owner, canonical, stateRoot });
});

it.each([false, true])(
  "settles old runtime-file results (source already copied: %s)",
  async (copied) => {
    const { proveGeneratedWorkspaceRecovery } =
      await import("./local-workspace-generated-paths.test-support.js");
    await proveGeneratedWorkspaceRecovery(owner, copied);
  },
);

it.each([1, 2] as const)(
  "settles historical nested Git v%s receipts without losing source edits",
  async (version) => {
    const { proveNestedGitWorkspaceRecovery } =
      await import("./local-workspace-generated-paths.test-support.js");
    await proveNestedGitWorkspaceRecovery(owner, version);
  },
);

it("preserves host-admitted build-root inputs while excluding guest cache churn", () =>
  proveHostAdmittedBuildInputs(owner));

it("expires an old runtime-file baseline while preserving unaccepted source", async () => {
  const { proveGeneratedWorkspaceExpiry } =
    await import("./local-workspace-generated-paths.test-support.js");
  await proveGeneratedWorkspaceExpiry(owner);
});

it.each([false, true])("settles command checkpoints (parent disposed: %s)", async (disposed) => {
  const { proveStoppedLocalWorkspaceCheckpoint } =
    await import("./local-workspace-cancellation.test-support.js");
  await proveStoppedLocalWorkspaceCheckpoint(owner, disposed);
});

it.each(["operator", "gateway"] as const)(
  "rejects canonical checkpoint writes after original %s authority ends",
  async (authority) => {
    const { proveStoppedSandboxAuthority } =
      await import("./local-workspace-cancellation.test-support.js");
    await proveStoppedSandboxAuthority(owner, authority);
  },
);

it("denies guest filesystem writes after role revocation and a late involvement receipt", async ({
  signal,
}) => {
  const { proveStoppedSandboxAuthority } =
    await import("./local-workspace-cancellation.test-support.js");
  await proveStoppedSandboxAuthority(owner, "guest-involvement", signal);
});

it("reconciles during shared state reads without caller-thread store SQL", () =>
  proveWorkerOwnedIncrementalWorkspace(owner));

it.skipIf(process.platform === "win32")(
  "reconciles metadata-prefilter edits, deletions, renames, modes, and symlinks after restart",
  () => proveIncrementalWorkspaceEdits(owner),
);

it("retains staged-input ownership when only a leaf changes in the checkpoint", () =>
  proveStagedInputCheckpointOwnership(owner));

it.runIf(process.env.OPENCLAW_TEST_LOCAL_PROJECTION_PODMAN === "1")(
  "edits and runs Git in a real required Podman sandbox across turns",
  ({ signal }) =>
    podmanFixture.run(async () => {
      signal.throwIfAborted();
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
      const { proveRequiredPodmanWorkspace } =
        await import("./local-workspace-podman.test-support.js");
      await proveRequiredPodmanWorkspace(root, owner, signal, podmanFixture.verifyCleanup);
    }),
  120000,
);

it("installs additive owner state without changing the database version", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  const [
    { tableExists },
    { OPENCLAW_STATE_SCHEMA_SQL },
    { FIRST_USE_STATE_TABLES },
    { extractSqliteTableSchema },
    { assertSqliteSchemaContains },
  ] = await Promise.all([
    import("../../state/openclaw-state-db-schema-helpers.js"),
    import("../../state/openclaw-state-schema.js"),
    import("../../state/openclaw-state-db-contract.js"),
    import("../../infra/sqlite-schema-sql.js"),
    import("../../infra/sqlite-schema-contract.test-support.js"),
  ]);
  const db = openOpenClawStateDatabase().db;
  const version = db
    .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
    .get();
  expect(tableExists(db, "local_workspace_projections")).toBe(false);
  await prepare();
  expect(
    db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
  ).toEqual(version);
  const priorSchema = OPENCLAW_STATE_SCHEMA_SQL.replace(
    extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "local_workspace_projections"),
    "",
  );
  expect(() =>
    assertSqliteSchemaContains(requireNativeSqliteDatabase(db), "prior schema", priorSchema, {
      allowedMissingTables: FIRST_USE_STATE_TABLES,
    }),
  ).not.toThrow();
  await closeOpenClawStateDatabaseAsync();
  expect((await readProjection())?.session_id).toBe(owner.sessionId);
});

it("seeds independent source-only Git and reconciles edits without host metadata or ignored secrets", async () => {
  await fs.mkdir(path.join(canonical, "src/lib"), { recursive: true });
  await writeText(canonical, "src/lib/source.ts", "nested seed");
  await git(canonical, "add", "src/lib/source.ts");
  await git(canonical, "commit", "--quiet", "-m", "nested seed");
  await writeText(canonical, "source.txt", "canonical edit\n");
  await writeText(canonical, "untracked.txt", "admitted source\n");
  const manifests = await import("./workspace-manifest-worker.js");
  const capture = vi.spyOn(manifests, "captureWorkspaceManifestDocument");
  const projection = await prepare();
  // The unpublished guest needs one baseline traversal; it cannot have guest edits yet.
  expect(capture.mock.calls.filter(([input]) => input.root !== canonical)).toHaveLength(1);
  capture.mockRestore();
  await expectText(projection, "src/lib/source.ts", "nested seed");
  await expectText(projection, "source.txt", "canonical edit\n");
  await expectText(projection, "untracked.txt", "admitted source\n");
  expect((await fs.lstat(path.join(projection, ".git"))).isDirectory()).toBe(true);
  expect(await git(projection, "rev-parse", "--git-common-dir")).toBe(".git");
  await expectMissing(projection, ".env.local");
  expect(await readText(projection, ".git", "config")).not.toContain("credential");
  await expectMissing(projection, ".git", "objects", "info", "alternates");
  await writeText(projection, "source.txt", "guest edit\n");
  expect(await prepare()).toBe(projection);
  await expectText(canonical, "source.txt", "guest edit\n");
  await expectText(repo, "source.txt", "original\n");
  expect(await git(projection, "status", "--porcelain")).toContain("source.txt");
});

it.each([false, true])(
  "recovers accepted unindexed inventory (retained membership: %s)",
  async (retainedMembership) => {
    const { proveAcceptedInventoryRecovery } =
      await import("./local-workspace-recovery.test-support.js");
    await proveAcceptedInventoryRecovery(owner, retainedMembership);
  },
);

it("never admits nested host secrets after guest de-ignore", async () => {
  const prefix = "nested/";
  await fs.mkdir(path.join(canonical, prefix), { recursive: true });
  const ignore = prefix + ".gitignore";
  await fs.writeFile(path.join(canonical, ignore), ".env.local\n.env.later\n");
  await fs.writeFile(path.join(canonical, prefix + ".env.local"), "synthetic host secret");
  const projection = await prepare();
  await fs.writeFile(path.join(projection, ignore), "");
  await synchronize();
  await fs.writeFile(path.join(canonical, prefix + ".env.later"), "new synthetic provisioning");
  await closeOpenClawStateDatabaseAsync();
  await prepare();
  for (const name of [".env.local", ".env.later"]) {
    await expectMissing(projection, prefix + name);
  }
});

it("keeps de-ignored host bytes outside guest and publication admission after archive restore", async () => {
  const { captureGitHubPublicationWorkspaceSnapshot } =
    await import("../github-publication-git-transport.js");
  const { service } = await archiveFixture();
  await git(repo, "config", "--unset-all", "credential.helper");
  const projection = await prepare();
  await writeText(projection, ".gitignore", "");
  await writeText(projection, "guest-new.txt", "guest source");
  await synchronize();
  await writeText(projection, "source.txt", "retained guest edit\n");
  const removed = await service.remove({ id: owner.worktree.id, reason: "de-ignore archive" });
  expect(removed.removed).toBe(true);
  expect(removed.snapshotRef).toBeTruthy();
  const tree = removed.snapshotRef!;
  await service.restore({ id: owner.worktree.id });
  await closeOpenClawStateDatabaseAsync();
  // Canonical archives retain host data, but restoring it is not guest admission.
  await expectText(canonical, ".env.local", "host-only-secret");
  await expectText(canonical, "source.txt", "retained guest edit\n");
  expect(await prepare()).toBe(projection);
  await expectMissing(projection, ".env.local");
  const paths = await treePaths(tree);
  expect(paths).toContain(".env.local");
  const publication = await captureGitHubPublicationWorkspaceSnapshot({ cwd: canonical });
  expect(await treePaths(publication.workspaceTree)).not.toContain(".env.local");
  expect(paths).toContain("guest-new.txt");
});

it.skipIf(process.platform === "win32").each(["initial", "later index"])(
  "rejects non-UTF-8 path aliases before guest capture: %s",
  async (when) => {
    const ignored = "private-\uFFFD";
    await fs.writeFile(path.join(canonical, ".gitignore"), ignored + "\n");
    await fs.writeFile(path.join(canonical, ignored), "synthetic ignored host secret");
    if (when === "later index") {
      await prepare();
    }
    // Git indexes preserve raw path bytes even when the host filesystem rejects them.
    const blob = await requireGit(canonical, ["hash-object", "-w", "--stdin"], {
      input: "ordinary source with an invalid filename",
    });
    await requireGit(canonical, ["update-index", "-z", "--index-info"], {
      input: Buffer.concat([Buffer.from(`100644 ${blob}\tprivate-`), Buffer.from([0xff, 0])]),
    });
    await expect(prepare()).rejects.toThrow("UTF-8");
  },
);

it("rejects an untracked non-UTF-8 path before initial guest capture", async ({ skip }) => {
  const name = Buffer.concat([Buffer.from("private-"), Buffer.from([0xff])]);
  const raw = Buffer.concat([Buffer.from(canonical + path.sep), name]);
  try {
    await fs.writeFile(raw, "ordinary untracked source", { flag: "wx" });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EILSEQ") {
      skip("filesystem rejects non-UTF-8 filenames (EILSEQ)");
    }
    throw error;
  }
  const names = await fs.readdir(canonical, { encoding: "buffer" });
  if (!names.some((entry) => entry.equals(name))) {
    skip("filesystem does not preserve raw filename bytes");
  }
  const ignored = "private-\uFFFD";
  await fs.writeFile(path.join(canonical, ".gitignore"), ignored + "\n");
  await fs.writeFile(path.join(canonical, ignored), "synthetic ignored host secret");
  await expect(prepare()).rejects.toThrow("UTF-8");
});

it("admits exact canonical source and host-staged new paths without trusting guest Git", async () => {
  await writeText(canonical, "initial.txt", "initial untracked source");
  const projection = await prepare();
  await expectText(projection, "initial.txt", "initial untracked source");
  await writeText(canonical, "initial.txt", "later canonical edit");
  await writeText(canonical, "new.txt", "new canonical source");
  await writeText(canonical, ".env.new", "new host-only provisioning");
  await writeText(projection, ".gitignore", "*.ignored\n");
  await writeText(projection, "guest.ignored", "guest-owned ignored bytes");
  await writeText(projection, ".env.new", "guest collision");
  await git(projection, "add", ".env.new");
  await expect(synchronize()).rejects.toThrow("conflict");
  // The conflict owner preserves both versions. Resolve this fixture by restoring
  // the guest's captured base, not by enrolling the host's colliding bytes.
  await fs.rm(path.join(canonical, ".env.new"));
  await settleProjection();
  await prepare();
  await expectText(projection, "initial.txt", "later canonical edit");
  await expectMissing(projection, "new.txt");
  await git(canonical, "add", "new.txt");
  await prepare();
  await expectText(projection, "new.txt", "new canonical source");
  await expectText(projection, "guest.ignored", "guest-owned ignored bytes");
});

it.skipIf(process.platform === "win32")(
  "never executes source repository helpers while seeding missing objects",
  async () => {
    const blob = await git(canonical, "rev-parse", "HEAD:source.txt");
    const object = path.join(repo, ".git/objects", blob.slice(0, 2), blob.slice(2));
    const bytes = await fs.readFile(object);
    const helper = path.join(root, "ssh-probe");
    await fs.writeFile(helper, '#!/bin/sh\nprintf invoked > "$0.ran"\nexit 1\n', { mode: 0o700 });
    await git(repo, "config", "remote.origin.url", "ssh://fixture.invalid/repository");
    await git(repo, "config", "remote.origin.promisor", "true");
    await git(repo, "config", "core.sshCommand", helper);
    await fs.rm(object);
    await expect(prepare()).rejects.toThrow();
    expect(existsSync(helper + ".ran")).toBe(false);
    await fs.writeFile(object, bytes);
    const projection = await prepare();
    await expectText(projection, "source.txt", "original\n");
    expect(existsSync(helper + ".ran")).toBe(false);
  },
);

it("keeps eligible nested project content and accepted empty directories across turns", async () => {
  const projection = await prepare();
  await fs.mkdir(path.join(projection, ".openclaw/sandbox-skills/skills"), { recursive: true });
  await fs.mkdir(path.join(projection, "src/empty"), { recursive: true });
  await writeText(projection, ".openclaw/project.json", "project content");
  await writeText(projection, "src/nested.ts", "nested content");
  await synchronize();
  await prepare();
  await expectText(projection, ".openclaw/project.json", "project content");
  await expectText(projection, "src/nested.ts", "nested content");
  expect((await fs.stat(path.join(projection, "src/empty"))).isDirectory()).toBe(true);
  await expectMissing(canonical, ".openclaw/sandbox-skills");
});

it("retains an accepted directory after deleting its last file across turns", async () => {
  await proveLastFileDirectoryRetention(owner);
});

it.each(["archive", "interrupted eviction"] as const)(
  "retains accepted directories with derived children through %s and restore",
  async (mode) => {
    const { service } = await archiveFixture();
    await proveAcceptedDirectoryRetention(owner, service, mode);
  },
);

it("retains both sides and a durable pending result when edits conflict", async () => {
  const projection = await prepare();
  await writeText(projection, "source.txt", "guest conflict\n");
  await writeText(canonical, "source.txt", "human conflict\n");
  await expect(synchronize()).rejects.toThrow("conflict");
  expect((await readProjection())?.pending_ref).toBeTruthy();
  await expectText(projection, "source.txt", "guest conflict\n");
  await expectText(canonical, "source.txt", "human conflict\n");
  await writeText(canonical, "source.txt", "original\n");
  await settleProjection();
  await expectText(canonical, "source.txt", "guest conflict\n");
  expect((await readProjection())?.pending_ref).toBeNull();
});

it("replaces rejected v31 storage when a full rescan matches the unchanged accepted root", async () => {
  const projection = await prepare();
  const accepted = (await readProjection())!;
  const { db } = openOpenClawStateDatabase();
  const records = readLocalWorkspaceTree(db, accepted.tree_root_digest!);
  for (const record of records.values()) {
    db.prepare(
      "INSERT INTO local_workspace_manifest_nodes (worktree_id, path, node_json) VALUES (?, ?, ?)",
    ).run(owner.worktree.id, record.node.path, JSON.stringify(record));
  }
  db.prepare(
    "UPDATE local_workspace_projections SET tree_root_digest = NULL WHERE worktree_id = ?",
  ).run(owner.worktree.id);
  db.prepare(`UPDATE local_workspace_manifest_nodes
    SET node_json = json_set(node_json, '$.node.sha256', ?)
    WHERE worktree_id = ? AND path = 'source.txt'`).run("f".repeat(64), owner.worktree.id);
  await synchronize();
  const replaced = (await readProjection())!;
  expect(replaced.baseline_ref).toBe(accepted.baseline_ref);
  expect(replaced.tree_root_digest).toEqual(accepted.tree_root_digest);
  expect(replaced.pending_ref).toBeNull();
  expect(
    db
      .prepare("SELECT count(*) AS n FROM local_workspace_manifest_nodes WHERE worktree_id = ?")
      .get(owner.worktree.id)!.n,
  ).toBe(0);
  await expectText(canonical, "source.txt", "original\n");
  await expectText(projection, "source.txt", "original\n");
});

it.each([
  "reservation",
  "v31 reservation",
  "v31 rejected conversion",
  "v31 rejected staged conversion",
  "acceptance",
  "accepted-result cleanup",
  "legacy accepted-result cleanup",
] as const)("recovers durable state when authority closes during %s", async (phase) => {
  await proveInterruptedWorkspaceCheckpoint(owner, phase, (value) => {
    revoked = value;
  });
});

it.for([false, true])(
  "waits for checkpoint resume before guest command preparation and cleanup (stopped: %s)",
  async (stopped, { signal }) => {
    const { bindLocalSandboxWorkspace } = await import("../../agents/sandbox/local-workspace.js");
    const { createSandboxTestContext } = await import("../../agents/sandbox/test-fixtures.js");
    const { createSandboxFsBridge } = await import("../../agents/sandbox/fs-bridge.js");
    const { resolveSandboxConfigForAgent } = await import("../../agents/sandbox/config.js");
    const registry = await import("../../agents/sandbox/registry.js");
    const engine = await import("../../agents/sandbox/container-engine.js");
    const docker = await import("../../agents/sandbox/docker.js");
    const { createDockerSandboxBackend } = await import("../../agents/sandbox/docker-backend.js");
    let ownerActive = true;
    const execution = new AbortController();
    using projection = await prepareSandboxCheckpointFixture(
      {
        ...owner,
        assertCurrent: () => {
          owner.assertCurrent();
          if (!ownerActive) {
            throw new Error("Workspace owner released before cleanup");
          }
        },
        [Symbol.dispose]() {
          ownerActive = false;
        },
      },
      () => execution.signal.throwIfAborted(),
    );
    const paused = createDeferred();
    const settle = createDeferred();
    vi.stubEnv("DOCKER_HOST", "unix:///synthetic/checkpoint-docker.sock");
    vi.stubEnv("DOCKER_CONTEXT", undefined);
    let runtimePaused = false;
    const events: string[] = [];
    const entry = {
      containerName: "checkpoint-command-owned",
      backendId: "docker",
      sessionKey: owner.sessionKey,
      workspaceDir: projection.workspaceDir,
      createdAtMs: 1,
      lastUsedAtMs: 1,
      image: "fixture",
    };
    await registry.updateRegistry(entry);
    const execResult = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    vi.spyOn(engine, "execContainer").mockImplementation(async (_engine, args) => {
      if (args[0] === "info") {
        return execResult("checkpoint-daemon");
      }
      if (args[0] === "inspect") {
        if (args.some((arg) => arg.includes("{{json .Mounts}}"))) {
          return execResult(JSON.stringify({ Mounts: [], Tmpfs: {} }));
        }
        if (args.includes("{{json .State}}")) {
          return execResult(
            JSON.stringify({
              Running: true,
              Paused: runtimePaused,
              Pid: 1,
              StartedAt: "2026-01-01T00:00:00.000Z",
            }),
          );
        }
        return execResult(
          args.includes("{{.State.Paused}}")
            ? String(runtimePaused)
            : `${"a".repeat(64)} true ${runtimePaused}`,
        );
      }
      if (args[0] === "exec") {
        return execResult("1 0 0:1 / / rw - overlay overlay rw\n");
      }
      if (args[0] === "pause") {
        runtimePaused = true;
        events.push("paused");
        paused.resolve();
        await settle.promise;
      } else if (args[0] === "unpause") {
        runtimePaused = false;
        events.push("resumed");
      }
      return execResult();
    });
    const dispatch = (kind: string) => {
      if (runtimePaused) {
        throw new Error("Container is paused");
      }
      events.push(kind);
    };
    // Keep the cleanup producer and projection gate real; model only container I/O.
    vi.spyOn(docker, "ensureSandboxContainer").mockResolvedValue({
      containerName: entry.containerName,
      containerId: "a".repeat(64),
      configHash: "checkpoint-fixture-config",
      mountPlan: {
        binds: [],
        protectedTargets: [],
        skippedBinds: [],
        readOnlyWorkspaceSkillMounts: [],
        tmpfs: [],
      },
      currentConfig: true,
    });
    vi.spyOn(docker, "execContainerRaw").mockImplementation(async (_engine, args) => {
      if (runtimePaused) {
        return { code: 125, stdout: Buffer.alloc(0), stderr: Buffer.from("Container is paused") };
      }
      events.push("cleanup");
      if (args.some((arg) => arg.includes("kill -TERM"))) {
        await writeText(projection.workspaceDir, "term-output.txt", "final descendant output\n");
      }
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    });
    const container = await createDockerSandboxBackend({
      cfg: resolveSandboxConfigForAgent({}, owner.agentId),
      scopeKey: owner.sessionKey,
      sessionKey: owner.sessionKey,
      workspaceDir: projection.workspaceDir,
      agentWorkspaceDir: canonical,
    });
    const backend: SandboxBackendHandle = {
      id: "docker",
      runtimeId: entry.containerName,
      runtimeLabel: entry.containerName,
      workdir: "/workspace",
      prepareProcessCleanup: container.prepareProcessCleanup!.bind(container),
      buildExecSpec: async () => {
        dispatch("exec");
        return { argv: ["true"], env: {}, stdinMode: "pipe-closed" };
      },
      runShellCommand: async () => {
        dispatch("shell");
        return { code: 0, stdout: Buffer.from("ready"), stderr: Buffer.alloc(0) };
      },
    };
    const sandbox = createSandboxTestContext({
      overrides: { workspaceDir: projection.workspaceDir, backend },
    });
    sandbox.fsBridge = createSandboxFsBridge({ sandbox: { ...sandbox, backend } });
    bindLocalSandboxWorkspace(sandbox, projection);
    const cleanup = backend.prepareProcessCleanup!({});
    const accepted = await backend.buildExecSpec({
      command: "true",
      env: cleanup.env,
      usePty: false,
    });
    events.length = 0;
    const finalize = (spec: typeof accepted) =>
      backend.finalizeExec!({
        status: "completed",
        exitCode: 0,
        timedOut: false,
        token: spec.finalizeToken,
      });
    const checkpoint = stopped ? finalize(accepted) : projection.checkpoint();
    let commands: Promise<unknown>[] = [];
    let pendingExec: ReturnType<typeof backend.buildExecSpec> | undefined;
    const acceptedFinalization = stopped ? checkpoint : undefined;
    try {
      await awaitGateBeforeSettlement(
        paused.promise,
        checkpoint,
        "Checkpoint did not pause runtime",
      );
      const controller = new AbortController();
      const reason = new Error("cancelled during checkpoint");
      const cancelled = backend.runShellCommand({ script: "true", signal: controller.signal });
      commands = [cancelled];
      controller.abort(reason);
      await expect(withinTest(cancelled, signal)).rejects.toMatchObject({
        code: "OPENCLAW_STATE_LEASE_ABORTED",
        cause: reason,
      });
      expect(runtimePaused).toBe(true);
      expect(events).toEqual(["paused"]);
      pendingExec = backend.buildExecSpec({ command: "true", env: {}, usePty: false });
      commands = [backend.runShellCommand({ script: "true" }), pendingExec];
      const stop = new Error("stopped during checkpoint");
      if (stopped) {
        execution.abort(stop);
        projection[Symbol.dispose]();
      }
      commands.push(cleanup.terminate(), cleanup.interrupt(1000));
      const outcomes = Promise.allSettled(commands);
      settle.resolve();
      await checkpoint;
      for (const [index, outcome] of (await outcomes).entries()) {
        if (stopped && index !== 2) {
          expect(outcome).toEqual({ status: "rejected", reason: stop });
        } else if (outcome.status === "rejected") {
          throw outcome.reason;
        }
      }
      await expectText(canonical, "term-output.txt", "final descendant output\n");
      expect(events.slice(0, 2)).toEqual(["paused", "resumed"]);
      expect(
        events.filter((event) => event !== "paused" && event !== "resumed").toSorted(),
      ).toEqual(stopped ? ["cleanup"] : ["cleanup", "cleanup", "exec", "shell"]);
      if (!stopped) {
        // Preparing an exec must release admission before that background command exits.
        await projection.provision(async () => events.push("next admission"));
        expect(events.at(-1)).toBe("next admission");
      }
    } finally {
      settle.resolve();
      await Promise.allSettled([checkpoint, ...commands]);
      await (acceptedFinalization ?? finalize(accepted));
      if (pendingExec) {
        const [result] = await Promise.allSettled([pendingExec]);
        if (result.status === "fulfilled") {
          await finalize(result.value);
        }
      }
      await registry.removeRegistryEntry(entry.containerName);
    }
  },
);

it("reports successful native eviction and restores accepted workspace contents", async () => {
  const { service } = await archiveFixture();
  const projection = await prepare();
  const authored = "accepted guest edit before native eviction\n";
  await writeText(projection, "source.txt", authored);
  await synchronize();
  const { withWorktreeAllocationLease } = await import("../../agents/worktrees/allocation.js");
  const { evictManagedWorktree } = await import("../../agents/worktrees/eviction.js");
  await expect(
    withWorktreeAllocationLease({ env: process.env }, (guard) =>
      evictManagedWorktree({
        env: process.env,
        record: owner.worktree,
        guard,
        reason: "idle-age",
        getConfig: () => ({}),
      }),
    ),
  ).resolves.toBe("dirty-purged");
  const removed = getRegistryWorktree(process.env, owner.worktree.id);
  expect(removed?.removedAt).toBeTypeOf("number");
  expect(removed?.snapshotRef).toBeTruthy();
  await expectMissing(canonical);
  await closeOpenClawStateDatabaseAsync();
  await service.restore({ id: owner.worktree.id });
  await prepare();
  await expectText(canonical, "source.txt", authored);
  await expectText(projection, "source.txt", authored);
  expect((await readProjection())?.pending_ref).toBeNull();
});

it.each(["legacy decoder", "failed restore retry", "retention", "legacy retention"] as const)(
  "preserves accepted ignored files, symlinks and empty directories through archive: %s",
  async (mode) => {
    const { restoreProvisionedFiles } = await import("../../agents/worktrees/provisioned-files.js");
    const { service, registry, retentionMs } = await archiveFixture([".env.allowed"]);
    const originalInput = ".artifacts/build-cache-inputs/node_modules/archived.json";
    await fs.mkdir(path.dirname(path.join(canonical, originalInput)), { recursive: true });
    await writeText(canonical, originalInput, "original archived input\n");
    await git(canonical, "add", "--force", "--", originalInput);
    await writeText(canonical, ".env.allowed", "original provisioned bytes");
    await fs.chmod(path.join(canonical, ".env.allowed"), 0o600);
    await writeText(canonical, ".gitignore", ".env.local\n.env.allowed\nguest-ignored/\n");
    await fs.mkdir(path.join(canonical, "guest-ignored"));
    await writeText(canonical, "guest-ignored/host-secret", "not guest custody");
    const projection = await prepare();
    await fs.mkdir(path.join(projection, "guest-ignored/empty"), { recursive: true });
    const bytes = Buffer.from("guest-owned ignored bytes\0\n");
    await fs.writeFile(path.join(projection, "guest-ignored/data"), bytes);
    if (process.platform !== "win32") {
      await fs.symlink("../source.txt", path.join(projection, "guest-ignored/link"));
    }
    await synchronize();
    expect(await fs.readFile(path.join(canonical, "guest-ignored/data"))).toEqual(bytes);
    const removed = await service.remove({
      id: owner.worktree.id,
      reason: "accepted-ignored-archive",
    });
    expect(removed.removed).toBe(true);
    expect(await treePaths(removed.snapshotRef!)).not.toContain("guest-ignored");
    const receipt = (await readProjection())!.pending_ref!;
    expect(receipt).toBeTruthy();
    const legacyState = (await registry.getRegistryWorktreeProvisionedState(
      process.env,
      owner.worktree.id,
    ))!;
    expect(legacyState).toEqual([{ path: ".env.allowed", mode: expect.any(Number), chunks: 1 }]);
    await closeOpenClawStateDatabaseAsync();
    if (mode === "retention" || mode === "legacy retention") {
      await registry.updateRegistryWorktree(process.env, owner.worktree.id, {
        removedAt: Date.now() - retentionMs - 1,
      });
      if (mode === "legacy retention") {
        await prepareLegacyArchiveRetention({ owner, receipt, originalInput });
      }
      await writeText(projection, "guest-ignored/data", "unaccepted newer bytes");
      expect((await service.gc()).snapshotsPruned).toBe(0);
      expect(await git(repo, "rev-parse", "--verify", removed.snapshotRef!)).toMatch(
        /^[a-f0-9]+$/u,
      );
      await fs.writeFile(path.join(projection, "guest-ignored/data"), bytes);
      const sql = observeLocalWorkspaceStoreSql();
      try {
        sql.calibrate();
        expect((await service.gc()).snapshotsPruned).toBe(1);
        sql.expectIdle();
      } finally {
        sql.restore();
      }
      expect(await readProjection()).toBeUndefined();
      expect(getRegistryWorktree(process.env, owner.worktree.id)).toBeUndefined();
      expect(
        await git(repo, "for-each-ref", "--format=%(refname)", receipt, removed.snapshotRef!),
      ).toBe("");
      await expect(fs.stat(projection)).rejects.toMatchObject({ code: "ENOENT" });
      return;
    }
    if (mode === "legacy decoder") {
      // Execute the pre-feature restore sequence and unchanged old decoder, not
      // just its schema preflight. The ledger contains only original regular files.
      const snapshot = await git(repo, "rev-parse", removed.snapshotRef!);
      const parent = await git(repo, "rev-parse", snapshot + "^");
      await git(
        repo,
        "worktree",
        "add",
        "--no-checkout",
        "-b",
        owner.worktree.branch,
        canonical,
        parent,
      );
      await git(canonical, "read-tree", "--reset", "--no-recurse-submodules", "-u", snapshot);
      await git(canonical, "reset", "--quiet", parent);
      await restoreProvisionedFiles(process.env, owner.worktree.id, canonical, legacyState);
      await expectText(canonical, ".env.allowed", "original provisioned bytes");
      expect(existsSync(path.join(canonical, "guest-ignored/data"))).toBe(false);
      await registry.updateRegistryWorktree(process.env, owner.worktree.id, {
        removedAt: undefined,
        lastActiveAt: Date.now(),
        provisionedPaths: legacyState.map((entry) => entry.path),
      });
      await closeOpenClawStateDatabaseAsync();
    } else {
      let injected = false;
      const acknowledgement = observeAcknowledgedUpdate((row) => {
        if (
          row.pending_ref &&
          row.pending_target === null &&
          existsSync(path.join(canonical, "guest-ignored/data"))
        ) {
          injected = true;
        }
      });
      await expect(
        service.restore({
          id: owner.worktree.id,
          commitGuard: () => {
            if (injected) {
              throw new Error("restore interrupted after overlay acceptance");
            }
          },
        }),
      ).rejects.toThrow("restore interrupted after overlay acceptance");
      acknowledgement.mockRestore();
      expect(injected).toBe(true);
      expect(existsSync(canonical)).toBe(false);
      expect((await readProjection())?.pending_ref).toBe(receipt);
      expect(getRegistryWorktree(process.env, owner.worktree.id)?.removedAt).toBeDefined();
      await service.restore({ id: owner.worktree.id });
    }
    await prepare();
    for (const workspace of [canonical, projection]) {
      await expectText(workspace, originalInput, "original archived input\n");
      expect(await fs.readFile(path.join(workspace, "guest-ignored/data"))).toEqual(bytes);
      expect((await fs.stat(path.join(workspace, "guest-ignored/empty"))).isDirectory()).toBe(true);
      if (process.platform !== "win32") {
        expect(await fs.readlink(path.join(workspace, "guest-ignored/link"))).toBe("../source.txt");
      }
      await expectMissing(workspace, "guest-ignored/host-secret");
      await expectMissing(workspace, ".env.local");
    }
    await expectText(canonical, ".env.allowed", "original provisioned bytes");
    await expectMissing(projection, ".env.allowed");
    expect((await readProjection())?.pending_ref).toBeNull();
    await git(repo, "config", "--unset-all", "credential.helper");
    const { captureGitHubPublicationWorkspaceSnapshot } =
      await import("../github-publication-git-transport.js");
    const published = await captureGitHubPublicationWorkspaceSnapshot({ cwd: canonical });
    expect(await treePaths(published.workspaceTree)).not.toContain("guest-ignored");
  },
);

it("preserves later inputs from an older archive without admitting new caches", async () => {
  const { service } = await archiveFixture();
  const projection = await prepare();
  const originalAdmission = (await readProjection())!.source_paths_json;
  const input = ".artifacts/build-cache-inputs/node_modules/late-original.json";
  expect(JSON.parse(originalAdmission)).not.toContain(input);
  await writeText(canonical, ".gitignore", ".env.local\n.artifacts/\n");
  await fs.mkdir(path.dirname(path.join(canonical, input)), { recursive: true });
  await writeText(canonical, input, "host-admitted input\n");
  await git(canonical, "add", "--force", "--", input);
  await prepare();
  await expectText(projection, input, "host-admitted input\n");
  const removed = await service.remove({ id: owner.worktree.id, reason: "legacy-admission-probe" });
  expect(removed.removed).toBe(true);
  expect(await treePaths(removed.snapshotRef!)).toContain(input);
  // Before this policy, host-index admission did not update source_paths_json.
  await withLocalWorkspaceStore({ worktreeId: owner.worktree.id }, async (store) => {
    await store.update(store.get()!, { source_paths_json: originalAdmission });
  });
  await closeOpenClawStateDatabaseAsync();
  await service.restore({ id: owner.worktree.id });
  await prepare();
  await expectText(projection, input, "host-admitted input\n");
  const generated = ".artifacts/build-cache-inputs/generated-after-restore.json";
  await writeText(projection, generated, "new disposable cache\n");
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    await fs.chmod(path.join(projection, generated), 0);
  }
  await writeText(projection, input, "restored authored edit\n");
  await synchronize();
  await expectText(canonical, input, "restored authored edit\n");
  await expectMissing(canonical, generated);
});

it.each(["lifecycle reset", "replacement session"] as const)(
  "preserves pending bytes across a %s without transferring session authority",
  async (change) => {
    const projection = await prepare();
    await writeText(projection, "source.txt", "unaccepted edit\n");
    if (change === "lifecycle reset") {
      const resumed = { ...owner, lifecycleRevision: randomUUID() };
      expect(await withLocalWorkspaceProjection(resumed, (state) => state.prepare())).toBe(
        projection,
      );
      await expectText(canonical, "source.txt", "unaccepted edit\n");
      expect((await readProjection())?.lifecycle_revision).toBe(resumed.lifecycleRevision);
    } else {
      await expect(
        withLocalWorkspaceProjection({ ...owner, sessionId: randomUUID() }, (state) =>
          state.prepare(),
        ),
      ).rejects.toThrow("different session incarnation");
      await expectText(projection, "source.txt", "unaccepted edit\n");
      revoked = true;
      await expect(prepare()).rejects.toThrow("revoked");
    }
  },
);
