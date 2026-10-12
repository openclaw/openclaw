import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { deleteRegistryWorktree } from "../../agents/worktrees/registry.js";
import { getRegistryWorktree } from "../../agents/worktrees/registry.test-support.js";
import {
  closeOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  withLocalWorkspaceProjection,
  withSettledLocalWorkspace,
} from "./local-workspace-projection.js";
import * as workspaceStore from "./local-workspace-store.js";
import { withLocalWorkspaceStore } from "./local-workspace-store.js";
import {
  observeLocalWorkspaceStoreSql,
  readLocalWorkspaceProjection,
} from "./local-workspace-store.test-support.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";

let root: string;
let stateRoot: string;
let owner: LocalWorkspaceOwner;
let revoked = false;
const git = (cwd: string, ...args: string[]) => requireGit(cwd, args);
const podmanFixture = createFixtureLifetime();
const readText = (directory: string, ...parts: string[]) =>
  fs.readFile(path.join(directory, ...parts), "utf8");
async function expectMissing(directory: string, ...parts: string[]) {
  await expect(fs.stat(path.join(directory, ...parts))).rejects.toMatchObject({ code: "ENOENT" });
}

function observeAcknowledgedUpdate(
  observe: (row: workspaceStore.LocalWorkspaceProjection) => void,
) {
  const withStore = workspaceStore.withLocalWorkspaceStore;
  return vi.spyOn(workspaceStore, "withLocalWorkspaceStore").mockImplementation((params, run) =>
    withStore(params, (store) =>
      run({
        ...store,
        update: async (row, patch, authority) => {
          const acknowledged = await store.update(row, patch, authority);
          observe(acknowledged);
          return acknowledged;
        },
      }),
    ),
  );
}

const suiteDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
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
  const repo = path.join(root, "source");
  const checkout = path.join(root, "canonical");
  await fs.mkdir(repo);
  await git(repo, "init", "--quiet", "-b", "main");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "user.email", "test@example.invalid");
  await fs.writeFile(path.join(repo, "source.txt"), "original\n");
  await fs.writeFile(path.join(repo, ".gitignore"), ".env.local\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "--quiet", "-m", "base");
  await git(repo, "worktree", "add", "--quiet", "-b", "openclaw/guest", checkout);
  await fs.writeFile(path.join(checkout, ".env.local"), "host-only-secret");
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
      path: checkout,
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
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe("local sandbox workspace reconciliation", () => {
  it("provisions, synchronizes, and retains reconciliation payloads without caller-thread store SQL", async () => {
    const sql = observeLocalWorkspaceStoreSql();
    try {
      sql.calibrate();
      const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
      await fs.writeFile(path.join(projection, "source.txt"), "worker-persisted edit\n");
      await withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
      expect(await readText(owner.worktree.path, "source.txt")).toBe("worker-persisted edit\n");
      const baseline = await withLocalWorkspaceStore(
        { worktreeId: owner.worktree.id },
        async (store) => {
          const row = store.get()!;
          const value = row.baseline_json + " ".repeat(6 * 1024 * 1024);
          await store.update(row, {
            baseline_json: value,
            baseline_ref: "sha256:" + createHash("sha256").update(value).digest("hex"),
          });
          return value;
        },
      );
      await withLocalWorkspaceProjection(owner, async (state) => {
        expect(state.current().baseline_json).toBe(baseline);
      });
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });

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
      import("../../infra/sqlite-schema-contract.js"),
    ]);
    const db = openOpenClawStateDatabase().db;
    const version = db
      .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
      .get();
    expect(tableExists(db, "local_workspace_projections")).toBe(false);
    await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    expect(
      db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
    ).toEqual(version);
    const priorSchema = OPENCLAW_STATE_SCHEMA_SQL.replace(
      extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "local_workspace_projections"),
      "",
    );
    expect(() =>
      assertSqliteSchemaContains(db, "prior schema", priorSchema, {
        allowedMissingTables: FIRST_USE_STATE_TABLES,
      }),
    ).not.toThrow();
    await closeOpenClawStateDatabaseAsync();
    expect((await readLocalWorkspaceProjection(owner.worktree.id))?.session_id).toBe(
      owner.sessionId,
    );
  });

  it("seeds independent source-only Git and reconciles edits without host metadata or ignored secrets", async () => {
    await fs.mkdir(path.join(owner.worktree.path, "src/lib"), { recursive: true });
    await fs.writeFile(path.join(owner.worktree.path, "src/lib/source.ts"), "nested seed");
    await git(owner.worktree.path, "add", "src/lib/source.ts");
    await git(owner.worktree.path, "commit", "--quiet", "-m", "nested seed");
    await fs.writeFile(path.join(owner.worktree.path, "source.txt"), "canonical edit\n");
    await fs.writeFile(path.join(owner.worktree.path, "untracked.txt"), "admitted source\n");
    const manifests = await import("./workspace-manifest-worker.js");
    const capture = vi.spyOn(manifests, "captureWorkspaceSnapshot");
    let projection: string;
    try {
      projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
      // The unpublished guest needs one baseline traversal; it cannot have guest edits yet.
      expect(
        capture.mock.calls.filter(([input]) => input.root !== owner.worktree.path),
      ).toHaveLength(1);
    } finally {
      capture.mockRestore();
    }
    expect(await readText(projection, "src/lib/source.ts")).toBe("nested seed");
    expect(await readText(projection, "source.txt")).toBe("canonical edit\n");
    expect(await readText(projection, "untracked.txt")).toBe("admitted source\n");
    expect((await fs.lstat(path.join(projection, ".git"))).isDirectory()).toBe(true);
    expect(await git(projection, "rev-parse", "--git-common-dir")).toBe(".git");
    await expectMissing(projection, ".env.local");
    expect(await readText(projection, ".git", "config")).not.toContain("credential");
    await expectMissing(projection, ".git", "objects", "info", "alternates");
    await fs.writeFile(path.join(projection, "source.txt"), "guest edit\n");
    expect(await withLocalWorkspaceProjection(owner, (state) => state.prepare())).toBe(projection);
    expect(await readText(owner.worktree.path, "source.txt")).toBe("guest edit\n");
    expect(await readText(owner.worktree.repoRoot, "source.txt")).toBe("original\n");
    expect(await git(projection, "status", "--porcelain")).toContain("source.txt");
  });

  it("never admits nested host secrets after guest de-ignore", async () => {
    const prefix = "nested/";
    await fs.mkdir(path.join(owner.worktree.path, prefix), { recursive: true });
    const ignore = prefix + ".gitignore";
    await fs.writeFile(path.join(owner.worktree.path, ignore), ".env.local\n.env.later\n");
    await fs.writeFile(
      path.join(owner.worktree.path, prefix + ".env.local"),
      "synthetic host secret",
    );
    const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    await fs.writeFile(path.join(projection, ignore), "");
    await withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
    await fs.writeFile(
      path.join(owner.worktree.path, prefix + ".env.later"),
      "new synthetic provisioning",
    );
    await closeOpenClawStateDatabaseAsync();
    await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    for (const name of [".env.local", ".env.later"]) {
      await expectMissing(projection, prefix + name);
    }
  });

  it("keeps de-ignored host bytes outside guest and publication admission after archive restore", async () => {
    const [
      { insertRegistryWorktree },
      { ManagedWorktreeService },
      { captureGitHubPublicationWorkspaceSnapshot },
    ] = await Promise.all([
      import("../../agents/worktrees/registry.js"),
      import("../../agents/worktrees/service.js"),
      import("../github-publication-git-transport.js"),
    ]);
    const service = new ManagedWorktreeService();
    owner.worktree.repoFingerprint = (
      await service.resolveRepositoryIdentity(owner.worktree.path)
    ).fingerprint;
    await insertRegistryWorktree(process.env, owner.worktree, { provisionedPaths: [] });
    await git(owner.worktree.repoRoot, "config", "--unset-all", "credential.helper");
    const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    await fs.writeFile(path.join(projection, ".gitignore"), "");
    await fs.writeFile(path.join(projection, "guest-new.txt"), "guest source");
    await withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
    await fs.writeFile(path.join(projection, "source.txt"), "retained guest edit\n");
    const removed = await service.remove({
      id: owner.worktree.id,
      reason: "de-ignore archive",
    });
    expect(removed.removed).toBe(true);
    expect(removed.snapshotRef).toBeTruthy();
    const tree = removed.snapshotRef!;
    await service.restore({ id: owner.worktree.id });
    await closeOpenClawStateDatabaseAsync();
    // Canonical archives retain host data, but restoring it is not guest admission.
    expect(await readText(owner.worktree.path, ".env.local")).toBe("host-only-secret");
    expect(await readText(owner.worktree.path, "source.txt")).toBe("retained guest edit\n");
    expect(await withLocalWorkspaceProjection(owner, (state) => state.prepare())).toBe(projection);
    await expectMissing(projection, ".env.local");
    const paths = await git(owner.worktree.repoRoot, "ls-tree", "-r", "--name-only", tree);
    expect(paths).toContain(".env.local");
    const publication = await captureGitHubPublicationWorkspaceSnapshot({
      cwd: owner.worktree.path,
    });
    expect(
      await git(owner.worktree.repoRoot, "ls-tree", "-r", "--name-only", publication.workspaceTree),
    ).not.toContain(".env.local");
    expect(paths).toContain("guest-new.txt");
  });

  it.skipIf(process.platform === "win32").each(["initial", "later index"])(
    "rejects non-UTF-8 path aliases before guest capture: %s",
    async (when) => {
      const ignored = "private-\uFFFD";
      await fs.writeFile(path.join(owner.worktree.path, ".gitignore"), ignored + "\n");
      await fs.writeFile(path.join(owner.worktree.path, ignored), "synthetic ignored host secret");
      if (when === "later index") {
        await withLocalWorkspaceProjection(owner, (state) => state.prepare());
      }
      // Git indexes preserve raw path bytes even when the host filesystem rejects them.
      const blob = await requireGit(owner.worktree.path, ["hash-object", "-w", "--stdin"], {
        input: "ordinary source with an invalid filename",
      });
      await requireGit(owner.worktree.path, ["update-index", "-z", "--index-info"], {
        input: Buffer.concat([Buffer.from(`100644 ${blob}\tprivate-`), Buffer.from([0xff, 0])]),
      });
      await expect(withLocalWorkspaceProjection(owner, (state) => state.prepare())).rejects.toThrow(
        "UTF-8",
      );
    },
  );

  it("rejects an untracked non-UTF-8 path before initial guest capture", async ({ skip }) => {
    const name = Buffer.concat([Buffer.from("private-"), Buffer.from([0xff])]);
    const raw = Buffer.concat([Buffer.from(owner.worktree.path + path.sep), name]);
    try {
      await fs.writeFile(raw, "ordinary untracked source", { flag: "wx" });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EILSEQ") {
        skip("filesystem rejects non-UTF-8 filenames (EILSEQ)");
      }
      throw error;
    }
    const names = await fs.readdir(owner.worktree.path, { encoding: "buffer" });
    if (!names.some((entry) => entry.equals(name))) {
      skip("filesystem does not preserve raw filename bytes");
    }
    const ignored = "private-\uFFFD";
    await fs.writeFile(path.join(owner.worktree.path, ".gitignore"), ignored + "\n");
    await fs.writeFile(path.join(owner.worktree.path, ignored), "synthetic ignored host secret");
    await expect(withLocalWorkspaceProjection(owner, (state) => state.prepare())).rejects.toThrow(
      "UTF-8",
    );
  });

  it("admits exact canonical source and host-staged new paths without trusting guest Git", async () => {
    await fs.writeFile(path.join(owner.worktree.path, "initial.txt"), "initial untracked source");
    const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    expect(await readText(projection, "initial.txt")).toBe("initial untracked source");
    await fs.writeFile(path.join(owner.worktree.path, "initial.txt"), "later canonical edit");
    await fs.writeFile(path.join(owner.worktree.path, "new.txt"), "new canonical source");
    await fs.writeFile(path.join(owner.worktree.path, ".env.new"), "new host-only provisioning");
    await fs.writeFile(path.join(projection, ".gitignore"), "*.ignored\n");
    await fs.writeFile(path.join(projection, "guest.ignored"), "guest-owned ignored bytes");
    await fs.writeFile(path.join(projection, ".env.new"), "guest collision");
    await git(projection, "add", ".env.new");
    await expect(
      withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical")),
    ).rejects.toThrow("conflict");
    // The conflict owner preserves both versions. Resolve this fixture by restoring
    // the guest's captured base, not by enrolling the host's colliding bytes.
    await fs.rm(path.join(owner.worktree.path, ".env.new"));
    await withLocalWorkspaceProjection(owner, (state) => state.settle());
    await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    expect(await readText(projection, "initial.txt")).toBe("later canonical edit");
    await expectMissing(projection, "new.txt");
    await git(owner.worktree.path, "add", "new.txt");
    await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    expect(await readText(projection, "new.txt")).toBe("new canonical source");
    expect(await readText(projection, "guest.ignored")).toBe("guest-owned ignored bytes");
  });

  it.skipIf(process.platform === "win32")(
    "never executes source repository helpers while seeding missing objects",
    async () => {
      const blob = await git(owner.worktree.path, "rev-parse", "HEAD:source.txt");
      const object = path.join(
        owner.worktree.repoRoot,
        ".git/objects",
        blob.slice(0, 2),
        blob.slice(2),
      );
      const bytes = await fs.readFile(object);
      const helper = path.join(root, "ssh-probe");
      await fs.writeFile(helper, '#!/bin/sh\nprintf invoked > "$0.ran"\nexit 1\n', { mode: 0o700 });
      await git(
        owner.worktree.repoRoot,
        "config",
        "remote.origin.url",
        "ssh://fixture.invalid/repository",
      );
      await git(owner.worktree.repoRoot, "config", "remote.origin.promisor", "true");
      await git(owner.worktree.repoRoot, "config", "core.sshCommand", helper);
      await fs.rm(object);
      await expect(
        withLocalWorkspaceProjection(owner, (state) => state.prepare()),
      ).rejects.toThrow();
      expect(existsSync(helper + ".ran")).toBe(false);
      await fs.writeFile(object, bytes);
      const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
      expect(await readText(projection, "source.txt")).toBe("original\n");
      expect(existsSync(helper + ".ran")).toBe(false);
    },
  );

  it("keeps eligible nested project content and accepted empty directories across turns", async () => {
    const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    await fs.mkdir(path.join(projection, ".openclaw/sandbox-skills/skills"), { recursive: true });
    await fs.mkdir(path.join(projection, "src/empty"), { recursive: true });
    await fs.writeFile(path.join(projection, ".openclaw/project.json"), "project content");
    await fs.writeFile(path.join(projection, "src/nested.ts"), "nested content");
    await withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
    await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    expect(await readText(projection, ".openclaw/project.json")).toBe("project content");
    expect(await readText(projection, "src/nested.ts")).toBe("nested content");
    expect((await fs.stat(path.join(projection, "src/empty"))).isDirectory()).toBe(true);
    await expectMissing(owner.worktree.path, ".openclaw/sandbox-skills");
  });

  it("retains both sides and a durable pending result when edits conflict", async () => {
    const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    await fs.writeFile(path.join(projection, "source.txt"), "guest conflict\n");
    await fs.writeFile(path.join(owner.worktree.path, "source.txt"), "human conflict\n");
    await expect(
      withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical")),
    ).rejects.toThrow("conflict");
    expect((await readLocalWorkspaceProjection(owner.worktree.id))?.pending_ref).toBeTruthy();
    expect(await readText(projection, "source.txt")).toBe("guest conflict\n");
    expect(await readText(owner.worktree.path, "source.txt")).toBe("human conflict\n");
    await fs.writeFile(path.join(owner.worktree.path, "source.txt"), "original\n");
    await withLocalWorkspaceProjection(owner, (state) => state.settle());
    expect(await readText(owner.worktree.path, "source.txt")).toBe("guest conflict\n");
    expect((await readLocalWorkspaceProjection(owner.worktree.id))?.pending_ref).toBeNull();
  });

  it.each(["acceptance", "accepted-result cleanup"] as const)(
    "recovers durable state when authority closes during %s",
    async (phase) => {
      const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
      const edit = "interrupted guest edit\n";
      const accepted = phase === "accepted-result cleanup";
      await fs.writeFile(path.join(projection, "source.txt"), edit);
      const acknowledgement = accepted
        ? observeAcknowledgedUpdate((row) => {
            if (row.pending_ref && row.pending_target === null) {
              revoked = true;
            }
          })
        : undefined;
      const interrupted = {
        ...owner,
        assertCurrent: () => {
          if (
            !accepted &&
            readFileSync(path.join(owner.worktree.path, "source.txt"), "utf8") === edit
          ) {
            revoked = true;
          }
          owner.assertCurrent();
        },
      };
      await expect(
        withLocalWorkspaceProjection(interrupted, (state) => state.synchronize("canonical")),
      ).rejects.toThrow(accepted ? "revoked" : undefined);
      acknowledgement?.mockRestore();
      if (accepted) {
        expect(await readLocalWorkspaceProjection(owner.worktree.id)).toMatchObject({
          pending_ref: expect.any(String),
          pending_target: null,
          journal_json: null,
        });
        await fs.writeFile(path.join(owner.worktree.path, "source.txt"), "later human edit\n");
      } else {
        expect((await readLocalWorkspaceProjection(owner.worktree.id))?.journal_json).toBeTruthy();
        expect((await readLocalWorkspaceProjection(owner.worktree.id))?.pending_ref).toBeTruthy();
      }
      revoked = false;
      if (accepted) {
        const pendingRef = (await readLocalWorkspaceProjection(owner.worktree.id))?.pending_ref;
        const preservedProjection = projection + "-preserved";
        await fs.rename(projection, preservedProjection);
        try {
          await expect(
            withLocalWorkspaceProjection(owner, (state) => state.prepare()),
          ).rejects.toThrow();
          expect((await readLocalWorkspaceProjection(owner.worktree.id))?.pending_ref).toBe(
            pendingRef,
          );
        } finally {
          await fs.rename(preservedProjection, projection);
        }
      }
      closeOpenClawStateDatabase();
      await withLocalWorkspaceProjection(owner, (state) => state.settle());
      expect(await readText(owner.worktree.path, "source.txt")).toBe(
        accepted ? "later human edit\n" : edit,
      );
      expect(await readLocalWorkspaceProjection(owner.worktree.id)).toMatchObject({
        journal_json: null,
        pending_ref: null,
      });
    },
  );

  it("retirement preserves a same-name replacement browser after quiescence", async () => {
    const [{ insertRegistryWorktree }, registry, engine] = await Promise.all([
      import("../../agents/worktrees/registry.js"),
      import("../../agents/sandbox/registry.js"),
      import("../../agents/sandbox/container-engine.js"),
    ]);
    await insertRegistryWorktree(process.env, owner.worktree, { provisionedPaths: [] });
    const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    const entry = {
      containerName: "retirement-owned",
      backendId: "docker",
      sessionKey: owner.sessionKey,
      workspaceDir: projection,
      createdAtMs: 1,
      lastUsedAtMs: 1,
      image: "fixture",
      cdpPort: 9222,
    };
    await registry.updateBrowserRegistry(entry);
    const captured = "a".repeat(64);
    const replacement = "b".repeat(64);
    const physical = new Set([captured]);
    let named = captured;
    const removeTargets: string[] = [];
    const execute = vi.spyOn(engine, "execContainer").mockImplementation(async (_engine, args) => {
      const target = args.at(-1) === entry.containerName ? named : args.at(-1)!;
      if (args[0] === "inspect") {
        if (!physical.has(target)) {
          return { code: 1, stdout: "", stderr: "no such container" };
        }
        return {
          code: 0,
          stdout: args.includes("{{.State.Paused}}")
            ? "false"
            : args.includes("{{.Id}}")
              ? target
              : target + " true false",
          stderr: "",
        };
      }
      if (args[0] === "pause") {
        physical.delete(captured);
        physical.add(replacement);
        named = replacement;
      }
      if (args[0] === "rm") {
        removeTargets.push(args.at(-1)!);
        physical.delete(target);
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const operation = vi.fn(async () => {});
    try {
      await expect(
        withSettledLocalWorkspace({ worktree: owner.worktree, retireRuntime: true }, operation),
      ).rejects.toThrow("generation");
      expect(physical.has(replacement)).toBe(true);
      expect(removeTargets).not.toContain(entry.containerName);
      expect(operation).not.toHaveBeenCalled();
      const remaining = await registry.readBrowserRegistry();
      expect(remaining.entries).toHaveLength(1);
    } finally {
      execute.mockRestore();
      await registry.removeBrowserRegistryEntry(entry.containerName);
    }
  });

  it.each(["legacy decoder", "failed restore retry", "retention"] as const)(
    "preserves accepted ignored files, symlinks and empty directories through archive: %s",
    async (mode) => {
      const [
        { insertRegistryWorktree, getRegistryWorktreeProvisionedState, updateRegistryWorktree },
        { ManagedWorktreeService, SNAPSHOT_RETENTION_MS },
        { restoreProvisionedFiles },
      ] = await Promise.all([
        import("../../agents/worktrees/registry.js"),
        import("../../agents/worktrees/service.js"),
        import("../../agents/worktrees/provisioned-files.js"),
      ]);
      let now = Date.now();
      const service = new ManagedWorktreeService({ now: () => now });
      owner.worktree.repoFingerprint = (
        await service.resolveRepositoryIdentity(owner.worktree.path)
      ).fingerprint;
      await insertRegistryWorktree(process.env, owner.worktree, {
        provisionedPaths: [".env.allowed"],
      });
      await fs.writeFile(
        path.join(owner.worktree.path, ".env.allowed"),
        "original provisioned bytes",
      );
      await fs.chmod(path.join(owner.worktree.path, ".env.allowed"), 0o600);
      await fs.writeFile(
        path.join(owner.worktree.path, ".gitignore"),
        ".env.local\n.env.allowed\nguest-ignored/\n",
      );
      await fs.mkdir(path.join(owner.worktree.path, "guest-ignored"));
      await fs.writeFile(
        path.join(owner.worktree.path, "guest-ignored/host-secret"),
        "not guest custody",
      );
      const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
      await fs.mkdir(path.join(projection, "guest-ignored/empty"), { recursive: true });
      const bytes = Buffer.from("guest-owned ignored bytes\0\n");
      await fs.writeFile(path.join(projection, "guest-ignored/data"), bytes);
      if (process.platform !== "win32") {
        await fs.symlink("../source.txt", path.join(projection, "guest-ignored/link"));
      }
      await withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
      expect(await fs.readFile(path.join(owner.worktree.path, "guest-ignored/data"))).toEqual(
        bytes,
      );
      const removed = await service.remove({
        id: owner.worktree.id,
        reason: "accepted-ignored-archive",
      });
      expect(removed.removed).toBe(true);
      expect(
        await git(owner.worktree.repoRoot, "ls-tree", "-r", "--name-only", removed.snapshotRef!),
      ).not.toContain("guest-ignored");
      const receipt = (await readLocalWorkspaceProjection(owner.worktree.id))!.pending_ref!;
      expect(receipt).toBeTruthy();
      const legacyState = (await getRegistryWorktreeProvisionedState(
        process.env,
        owner.worktree.id,
      ))!;
      expect(legacyState).toEqual([{ path: ".env.allowed", mode: expect.any(Number), chunks: 1 }]);
      await closeOpenClawStateDatabaseAsync();
      if (mode === "retention") {
        now += SNAPSHOT_RETENTION_MS + 1;
        await fs.writeFile(path.join(projection, "guest-ignored/data"), "unaccepted newer bytes");
        expect((await service.gc()).snapshotsPruned).toBe(0);
        expect(
          await git(owner.worktree.repoRoot, "rev-parse", "--verify", removed.snapshotRef!),
        ).toMatch(/^[a-f0-9]+$/u);
        await fs.writeFile(path.join(projection, "guest-ignored/data"), bytes);
        const sql = observeLocalWorkspaceStoreSql();
        try {
          sql.calibrate();
          expect((await service.gc()).snapshotsPruned).toBe(1);
          sql.expectIdle();
        } finally {
          sql.restore();
        }
        expect(await readLocalWorkspaceProjection(owner.worktree.id)).toBeUndefined();
        expect(getRegistryWorktree(process.env, owner.worktree.id)).toBeUndefined();
        expect(
          await git(
            owner.worktree.repoRoot,
            "for-each-ref",
            "--format=%(refname)",
            receipt,
            removed.snapshotRef!,
          ),
        ).toBe("");
        await expect(fs.stat(projection)).rejects.toMatchObject({ code: "ENOENT" });
        return;
      }
      if (mode === "legacy decoder") {
        // Execute the pre-feature restore sequence and unchanged old decoder, not
        // just its schema preflight. The ledger contains only original regular files.
        const snapshot = await git(owner.worktree.repoRoot, "rev-parse", removed.snapshotRef!);
        const parent = await git(owner.worktree.repoRoot, "rev-parse", snapshot + "^");
        await git(
          owner.worktree.repoRoot,
          "worktree",
          "add",
          "--no-checkout",
          "-b",
          owner.worktree.branch,
          owner.worktree.path,
          parent,
        );
        await git(
          owner.worktree.path,
          "read-tree",
          "--reset",
          "--no-recurse-submodules",
          "-u",
          snapshot,
        );
        await git(owner.worktree.path, "reset", "--quiet", parent);
        await restoreProvisionedFiles(
          process.env,
          owner.worktree.id,
          owner.worktree.path,
          legacyState,
        );
        expect(await readText(owner.worktree.path, ".env.allowed")).toBe(
          "original provisioned bytes",
        );
        expect(existsSync(path.join(owner.worktree.path, "guest-ignored/data"))).toBe(false);
        await updateRegistryWorktree(process.env, owner.worktree.id, {
          removedAt: undefined,
          lastActiveAt: now + 1,
          provisionedPaths: legacyState.map((entry) => entry.path),
        });
        await closeOpenClawStateDatabaseAsync();
      } else {
        let injected = false;
        const acknowledgement = observeAcknowledgedUpdate((row) => {
          if (
            row.pending_ref &&
            row.pending_target === null &&
            existsSync(path.join(owner.worktree.path, "guest-ignored/data"))
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
        expect(existsSync(owner.worktree.path)).toBe(false);
        expect((await readLocalWorkspaceProjection(owner.worktree.id))?.pending_ref).toBe(receipt);
        expect(getRegistryWorktree(process.env, owner.worktree.id)?.removedAt).toBeDefined();
        await service.restore({ id: owner.worktree.id });
      }
      await withLocalWorkspaceProjection(owner, (state) => state.prepare());
      for (const workspace of [owner.worktree.path, projection]) {
        expect(await fs.readFile(path.join(workspace, "guest-ignored/data"))).toEqual(bytes);
        expect((await fs.stat(path.join(workspace, "guest-ignored/empty"))).isDirectory()).toBe(
          true,
        );
        if (process.platform !== "win32") {
          expect(await fs.readlink(path.join(workspace, "guest-ignored/link"))).toBe(
            "../source.txt",
          );
        }
        await expectMissing(workspace, "guest-ignored/host-secret");
        await expectMissing(workspace, ".env.local");
      }
      expect(await readText(owner.worktree.path, ".env.allowed")).toBe(
        "original provisioned bytes",
      );
      await expectMissing(projection, ".env.allowed");
      expect((await readLocalWorkspaceProjection(owner.worktree.id))?.pending_ref).toBeNull();
      await git(owner.worktree.repoRoot, "config", "--unset-all", "credential.helper");
      const { captureGitHubPublicationWorkspaceSnapshot } =
        await import("../github-publication-git-transport.js");
      const published = await captureGitHubPublicationWorkspaceSnapshot({
        cwd: owner.worktree.path,
      });
      expect(
        await git(owner.worktree.path, "ls-tree", "-r", "--name-only", published.workspaceTree),
      ).not.toContain("guest-ignored");
    },
  );

  it.each(["lifecycle reset", "replacement session"] as const)(
    "preserves pending bytes across a %s without transferring session authority",
    async (change) => {
      const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
      await fs.writeFile(path.join(projection, "source.txt"), "unaccepted edit\n");
      if (change === "lifecycle reset") {
        const resumed = { ...owner, lifecycleRevision: randomUUID() };
        expect(await withLocalWorkspaceProjection(resumed, (state) => state.prepare())).toBe(
          projection,
        );
        expect(await readText(owner.worktree.path, "source.txt")).toBe("unaccepted edit\n");
        expect((await readLocalWorkspaceProjection(owner.worktree.id))?.lifecycle_revision).toBe(
          resumed.lifecycleRevision,
        );
      } else {
        await expect(
          withLocalWorkspaceProjection({ ...owner, sessionId: randomUUID() }, (state) =>
            state.prepare(),
          ),
        ).rejects.toThrow("different session incarnation");
        expect(await readText(projection, "source.txt")).toBe("unaccepted edit\n");
        revoked = true;
        await expect(
          withLocalWorkspaceProjection(owner, (state) => state.prepare()),
        ).rejects.toThrow("revoked");
      }
    },
  );
});
