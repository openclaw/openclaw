import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerWorktreesCli } from "../../cli/worktrees-cli.js";
import { localWorkspaceStore } from "../../gateway/worker-environments/local-workspace-store.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { defaultRuntime } from "../../runtime.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import * as worktreeGit from "./git.js";
import {
  getRegistryWorktree,
  getRegistryWorktreeProvisionedChunk,
  insertRegistryWorktree,
  insertRegistryWorktreeProvisionedChunk,
  updateRegistryWorktree,
} from "./registry.js";
import { resolveRepository } from "./service-preparation.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";
import { retireManagedWorktreeSnapshotById } from "./snapshot-host.js";
import type { ManagedWorktreeRecord } from "./types.js";

const execFileAsync = promisify(execFile);
const removedAt = 1_700_000_000_100;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" },
  });
  return stdout.trim();
}

describe("Exact removed worktree snapshot retirement", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(async () => {
      vi.restoreAllMocks();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      vi.unstubAllEnvs();
      cleanup();
    });
  });
  let root: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let record: ManagedWorktreeRecord;
  let request: Parameters<typeof retireManagedWorktreeSnapshotById>[0];
  let source: string;
  let tree: string;

  beforeEach(async () => {
    root = tempDirs.make("openclaw-snapshot-retirement-");
    repo = await initializeRepository(root);
    const stateDir = path.join(root, "state");
    await fs.mkdir(stateDir);
    expect(await fs.realpath(stateDir)).toBe(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("GIT_NO_LAZY_FETCH", "1");
    vi.stubEnv("GIT_OPTIONAL_LOCKS", "0");
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    source = await git(repo, "rev-parse", "HEAD");
    tree = await git(repo, "rev-parse", "HEAD^{tree}");
    const repository = await resolveRepository(repo);
    const id = "a0000000-0000-4000-8000-000000000001";
    record = {
      id,
      name: "retired",
      repoFingerprint: repository.fingerprint,
      repoRoot: repository.repoRoot,
      path: path.join(root, "retired"),
      branch: "openclaw/retired",
      baseRef: "main",
      ownerKind: "session",
      ownerId: "agent:main:test:snapshot-retirement",
      createdAt: removedAt - 100,
      lastActiveAt: removedAt - 1,
      removedAt,
      snapshotRef: `refs/openclaw/snapshots/${id}`,
    };
    const snapshot = await git(repo, "commit-tree", tree, "-p", source, "-m", "removed snapshot");
    await git(repo, "update-ref", record.snapshotRef!, snapshot);
    const retainedSourceRef = "refs/heads/retained-source";
    await git(repo, "update-ref", retainedSourceRef, source);
    insertRegistryWorktree(env, record, { provisionedPaths: [] });
    const database = openOpenClawStateDatabase({ env });
    expect(await fs.realpath(database.path)).toBe(path.join(stateDir, "state", "openclaw.sqlite"));
    request = {
      id,
      expectedSnapshotRef: record.snapshotRef!,
      expectedSnapshotOid: snapshot,
      expectedRemovedAt: removedAt,
      retainedSourceRef,
      expectedRetainedSourceOid: source,
    };
  });

  async function expectPreserved(expected: ManagedWorktreeRecord | undefined) {
    expect(getRegistryWorktree(env, record.id)).toEqual(expected);
    expect(await git(repo, "rev-parse", "--verify", record.snapshotRef!)).toBe(
      request.expectedSnapshotOid,
    );
    expect(await git(repo, "rev-parse", request.retainedSourceRef)).toBe(source);
  }

  function retirementCli() {
    const program = new Command().name("openclaw").exitOverride();
    program.configureOutput({ writeErr: () => undefined });
    registerWorktreesCli(program);
    const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
    const argv = [
      "node",
      "openclaw",
      "worktrees",
      "retire-snapshot",
      record.id,
      "--expected-ref",
      request.expectedSnapshotRef,
      "--expected-oid",
      request.expectedSnapshotOid,
      "--removed-at",
      String(request.expectedRemovedAt),
      "--retained-ref",
      request.retainedSourceRef,
      "--retained-oid",
      request.expectedRetainedSourceOid,
      "--json",
    ];
    return { program, output, argv };
  }

  it("retires through the Commander entrypoint and reports the exact disposition as JSON", async () => {
    const cli = retirementCli();
    await cli.program.parseAsync(cli.argv);
    expect(cli.output).toHaveBeenCalledExactlyOnceWith({ retired: true, id: record.id });
    expect(getRegistryWorktree(env, record.id)).toBeUndefined();
    await expect(git(repo, "show-ref", "--verify", record.snapshotRef!)).rejects.toThrow();
    expect(await git(repo, "rev-parse", request.retainedSourceRef)).toBe(source);
  });

  it.each(["wrong timestamp", "missing required argument"])(
    "preserves snapshot custody through the CLI with %s",
    async (kind) => {
      const cli = retirementCli();
      if (kind === "wrong timestamp") {
        cli.argv[cli.argv.indexOf("--removed-at") + 1] = String(removedAt + 1);
      } else {
        cli.argv.splice(cli.argv.indexOf("--retained-oid"), 2);
      }
      await expect(cli.program.parseAsync(cli.argv)).rejects.toThrow(
        kind === "wrong timestamp" ? /snapshot identity does not match/ : /required option/,
      );
      expect(cli.output).not.toHaveBeenCalled();
      await expectPreserved(record);
    },
  );

  it("retires only the exact redundant snapshot and record, preserving foreign recovery and PR outcomes", async () => {
    const foreign: ManagedWorktreeRecord = {
      ...record,
      id: "a0000000-0000-4000-8000-000000000002",
      name: "foreign",
      path: path.join(root, "foreign"),
      branch: "openclaw/foreign",
      snapshotRef: "refs/openclaw/snapshots/a0000000-0000-4000-8000-000000000002",
    };
    insertRegistryWorktree(env, foreign, { provisionedPaths: [] });
    await git(repo, "update-ref", foreign.snapshotRef!, source);
    const outcome = "refs/openclaw/pr-merge-outcomes/123";
    await git(repo, "update-ref", outcome, source);

    await expect(retireManagedWorktreeSnapshotById(request)).resolves.toEqual({
      retired: true,
      id: record.id,
    });

    expect(getRegistryWorktree(env, record.id)).toBeUndefined();
    await expect(git(repo, "show-ref", "--verify", record.snapshotRef!)).rejects.toThrow();
    await expect(fs.lstat(record.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(getRegistryWorktree(env, foreign.id)).toEqual(foreign);
    expect(await git(repo, "rev-parse", foreign.snapshotRef!)).toBe(source);
    expect(await git(repo, "rev-parse", outcome)).toBe(source);
    expect(await git(repo, "rev-parse", request.retainedSourceRef)).toBe(source);
    expect(await git(repo, "show", "HEAD:README.md")).toBe("base");
  });

  it.each([
    ["ID", { id: "a0000000-0000-4000-8000-000000000099" }],
    ["snapshot namespace", { expectedSnapshotRef: "refs/heads/main" }],
    ["removal generation", { expectedRemovedAt: removedAt + 1 }],
    ["snapshot OID", { expectedSnapshotOid: "1".repeat(40) }],
    ["retained source OID", { expectedRetainedSourceOid: "2".repeat(40) }],
  ] as const)("preserves custody when the expected %s does not match", async (_label, patch) => {
    await expect(retireManagedWorktreeSnapshotById({ ...request, ...patch })).rejects.toThrow(
      /snapshot identity does not match|ref OID changed/,
    );
    await expectPreserved(record);
  });

  it("preserves exact-state recovery instead of treating it as a redundant ordinary snapshot", async () => {
    const exactRef = `refs/openclaw/snapshots/exact-v1/${record.id}`;
    await git(repo, "update-ref", exactRef, request.expectedSnapshotOid);
    updateRegistryWorktree(env, record.id, { snapshotRef: exactRef });
    const exactRecord = getRegistryWorktree(env, record.id);
    const recovery = path.join(root, "exact-recovery");
    await git(repo, "worktree", "add", "--detach", recovery, source);
    await fs.writeFile(path.join(recovery, "newer.txt"), "write after capture");
    const registrations = await git(repo, "worktree", "list", "--porcelain");

    await expect(
      retireManagedWorktreeSnapshotById({ ...request, expectedSnapshotRef: exactRef }),
    ).rejects.toThrow(/Invalid exact snapshot retirement identity/);

    expect(getRegistryWorktree(env, record.id)).toEqual(exactRecord);
    expect(await git(repo, "rev-parse", exactRef)).toBe(request.expectedSnapshotOid);
    expect(await fs.readFile(path.join(recovery, "newer.txt"), "utf8")).toBe("write after capture");
    expect(await git(repo, "worktree", "list", "--porcelain")).toBe(registrations);
    expect(await git(repo, "rev-parse", request.retainedSourceRef)).toBe(source);
  });

  it("refuses a live registry lifecycle", async () => {
    updateRegistryWorktree(env, record.id, { removedAt: undefined });
    const live = getRegistryWorktree(env, record.id);
    await expect(retireManagedWorktreeSnapshotById(request)).rejects.toThrow(
      /snapshot identity does not match/,
    );
    await expectPreserved(live);
  });

  it("refuses changed repository identity", async () => {
    updateRegistryWorktree(env, record.id, {
      repositoryIdentity: { repoRoot: repo, repoFingerprint: "foreign-fingerprint" },
    });
    const changed = getRegistryWorktree(env, record.id);
    await expect(retireManagedWorktreeSnapshotById(request)).rejects.toThrow(
      /repository identity changed/,
    );
    await expectPreserved(changed);
  });

  it.each(["directory", "dangling symlink"])("refuses a reappeared checkout %s", async (kind) => {
    if (kind === "directory") {
      await fs.mkdir(record.path);
      await fs.writeFile(path.join(record.path, "newer.txt"), "newer source");
    } else {
      await fs.symlink(path.join(root, "missing-target"), record.path);
    }
    await expect(retireManagedWorktreeSnapshotById(request)).rejects.toThrow(
      /checkout or Git registration/,
    );
    await expectPreserved(record);
    if (kind === "directory") {
      expect(await fs.readFile(path.join(record.path, "newer.txt"), "utf8")).toBe("newer source");
    } else {
      expect(await fs.readlink(record.path)).toBe(path.join(root, "missing-target"));
    }
  });

  it("refuses a lingering Git registration even when the checkout path is absent", async () => {
    await git(repo, "worktree", "add", "--detach", record.path, source);
    await fs.rm(record.path, { recursive: true });
    const registered = await git(repo, "worktree", "list", "--porcelain");
    expect(registered).toContain(record.path);
    await expect(retireManagedWorktreeSnapshotById(request)).rejects.toThrow(
      /checkout or Git registration/,
    );
    await expectPreserved(record);
    expect(await git(repo, "worktree", "list", "--porcelain")).toBe(registered);
  });

  it.each(["live run", "unknown run", "removal"])("preserves a %s consumer", async (kind) => {
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const query = getNodeSqliteKysely<Pick<DB, "state_leases">>(db);
        executeSqliteQuerySync(
          db,
          query.insertInto("state_leases").values({
            scope: `worktree-run:${record.id}`,
            lease_key: kind === "removal" ? "__removing__" : "retained-run",
            owner: "synthetic-consumer",
            expires_at: null,
            heartbeat_at: null,
            payload_json: JSON.stringify(kind === "unknown run" ? {} : { pid: process.pid }),
            created_at: removedAt,
            updated_at: removedAt,
          }),
        );
      },
      { env },
    );
    await expect(retireManagedWorktreeSnapshotById(request)).rejects.toThrow(
      /run\/removal consumer/,
    );
    await expectPreserved(record);
    const { db } = openOpenClawStateDatabase({ env });
    expect(
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<Pick<DB, "state_leases">>(db)
          .selectFrom("state_leases")
          .select("owner")
          .where("scope", "=", `worktree-run:${record.id}`),
      ).rows,
    ).toEqual([{ owner: "synthetic-consumer" }]);
  });

  it.each(["missing ledger", "unknown ledger", "provisioned ledger", "orphan chunk"])(
    "preserves %s instead of assuming the Git tree contains all recovery data",
    async (kind) => {
      const chunk = { worktreeId: record.id, path: "local.env", chunkIndex: 0 };
      const bytes = Buffer.from("private provisioned content");
      if (kind === "missing ledger") {
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            executeSqliteQuerySync(
              db,
              getNodeSqliteKysely<Pick<DB, "worktrees">>(db)
                .updateTable("worktrees")
                .set({ provisioned_paths_json: null })
                .where("id", "=", record.id),
            );
          },
          { env },
        );
      } else if (kind === "unknown ledger") {
        // A legacy path-only ledger does not prove an empty captured-file inventory.
        updateRegistryWorktree(env, record.id, { provisionedPaths: [chunk.path] });
      } else if (kind === "provisioned ledger") {
        updateRegistryWorktree(env, record.id, {
          provisionedState: [{ path: chunk.path, mode: 0o600, chunks: 1 }],
        });
        insertRegistryWorktreeProvisionedChunk(env, { ...chunk, data: bytes });
      } else {
        insertRegistryWorktreeProvisionedChunk(env, { ...chunk, data: bytes });
      }
      await expect(retireManagedWorktreeSnapshotById(request)).rejects.toThrow(
        /retains provisioned data/,
      );
      await expectPreserved(record);
      if (kind === "provisioned ledger" || kind === "orphan chunk") {
        expect(Buffer.from((await getRegistryWorktreeProvisionedChunk(env, chunk))!)).toEqual(
          bytes,
        );
      }
    },
  );

  it("refuses a pending-removal pin without deleting it", async () => {
    const pending = `refs/openclaw/removals/${record.id}`;
    await git(repo, "update-ref", pending, source);
    await expect(retireManagedWorktreeSnapshotById(request)).rejects.toThrow(
      /pending removal custody/,
    );
    await expectPreserved(record);
    expect(await git(repo, "rev-parse", pending)).toBe(source);
  });

  it("preserves projection custody and ignored bytes that Git equality cannot cover", async () => {
    const projection = path.join(
      env.OPENCLAW_STATE_DIR!,
      "worktree-projections",
      record.id,
      "workspace",
    );
    await fs.mkdir(projection, { recursive: true });
    const payload = path.join(projection, "ignored-owned.txt");
    await fs.writeFile(payload, "projection-only content");
    const store = localWorkspaceStore(env);
    const row = store.create(
      {
        worktree_id: record.id,
        agent_id: "main",
        session_key: record.ownerId!,
        session_id: "b0000000-0000-4000-8000-000000000001",
        lifecycle_revision: null,
        projection_path: projection,
        base_commit: source,
        source_paths_json: JSON.stringify(["README.md"]),
        baseline_json: null,
        baseline_ref: null,
        pending_ref: null,
        pending_target: null,
        journal_json: null,
        journal_pack: null,
        paused_runtimes_json: null,
        created_at_ms: removedAt - 1,
      },
      () => undefined,
    );
    await expect(retireManagedWorktreeSnapshotById(request)).rejects.toThrow(/projection custody/);
    await expectPreserved(record);
    expect(store.get(record.id)).toEqual(row);
    expect(await fs.readFile(payload, "utf8")).toBe("projection-only content");
  });

  it("preserves a symbolic snapshot ref and its foreign target", async () => {
    await git(repo, "update-ref", "-d", record.snapshotRef!);
    await git(repo, "symbolic-ref", record.snapshotRef!, request.retainedSourceRef);
    await expect(
      retireManagedWorktreeSnapshotById({ ...request, expectedSnapshotOid: source }),
    ).rejects.toThrow(/direct, not symbolic, refs/);
    expect(getRegistryWorktree(env, record.id)).toEqual(record);
    expect(await git(repo, "symbolic-ref", record.snapshotRef!)).toBe(request.retainedSourceRef);
    expect(await git(repo, "rev-parse", request.retainedSourceRef)).toBe(source);
  });

  it("preserves a snapshot with source content absent from the retained ref", async () => {
    await fs.writeFile(path.join(repo, "README.md"), "unique snapshot bytes");
    await git(repo, "add", "README.md");
    const uniqueTree = await git(repo, "write-tree");
    const uniqueSnapshot = await git(repo, "commit-tree", uniqueTree, "-p", source, "-m", "unique");
    await git(repo, "update-ref", record.snapshotRef!, uniqueSnapshot);
    await expect(
      retireManagedWorktreeSnapshotById({ ...request, expectedSnapshotOid: uniqueSnapshot }),
    ).rejects.toThrow(/source not covered by the retained commit/);
    expect(getRegistryWorktree(env, record.id)).toEqual(record);
    expect(await git(repo, "show", `${record.snapshotRef}:README.md`)).toBe(
      "unique snapshot bytes",
    );
  });

  it("preserves same-tree snapshots whose parent history is not retained", async () => {
    const unrelated = await git(repo, "commit-tree", tree, "-m", "unrelated history");
    const snapshot = await git(
      repo,
      "commit-tree",
      tree,
      "-p",
      unrelated,
      "-m",
      "unretained parent",
    );
    await git(repo, "update-ref", record.snapshotRef!, snapshot);
    await expect(
      retireManagedWorktreeSnapshotById({ ...request, expectedSnapshotOid: snapshot }),
    ).rejects.toThrow(/merge-base/);
    expect(getRegistryWorktree(env, record.id)).toEqual(record);
    expect(await git(repo, "rev-parse", record.snapshotRef!)).toBe(snapshot);
  });

  it.each(["snapshot", "retained source", "pending removal"])(
    "rejects changed %s custody at the Git deletion boundary",
    async (kind) => {
      const replacement = await git(repo, "commit-tree", tree, "-p", source, "-m", "new snapshot");
      const target =
        kind === "snapshot"
          ? record.snapshotRef!
          : kind === "retained source"
            ? request.retainedSourceRef
            : `refs/openclaw/removals/${record.id}`;
      const realGit = worktreeGit.requireGit;
      let replaced = false;
      vi.spyOn(worktreeGit, "requireGit").mockImplementation(async (cwd, args, options) => {
        if (
          !replaced &&
          args[0] === "update-ref" &&
          args.includes("--stdin") &&
          String(options?.input).includes(`delete ${record.snapshotRef} `)
        ) {
          replaced = true;
          await git(repo, "update-ref", target, replacement);
        }
        return await realGit(cwd, args, options);
      });
      await expect(retireManagedWorktreeSnapshotById(request)).rejects.toThrow(
        /cannot lock ref|reference already exists/,
      );
      expect(replaced).toBe(true);
      expect(getRegistryWorktree(env, record.id)).toEqual(record);
      expect(await git(repo, "rev-parse", target)).toBe(replacement);
      expect(await git(repo, "rev-parse", record.snapshotRef!)).toBe(
        kind === "snapshot" ? replacement : request.expectedSnapshotOid,
      );
      expect(await git(repo, "rev-parse", request.retainedSourceRef)).toBe(
        kind === "retained source" ? replacement : source,
      );
    },
  );

  it("preserves a newer registry lifecycle observed at the deletion boundary", async () => {
    const realGit = worktreeGit.requireGit;
    let changed = false;
    vi.spyOn(worktreeGit, "requireGit").mockImplementation(async (cwd, args, options) => {
      if (
        !changed &&
        args[0] === "update-ref" &&
        args.includes("--stdin") &&
        String(options?.input).includes(`delete ${record.snapshotRef} `)
      ) {
        changed = true;
        updateRegistryWorktree(env, record.id, { removedAt: removedAt + 1 });
      }
      return await realGit(cwd, args, options);
    });
    await expect(retireManagedWorktreeSnapshotById(request)).rejects.toThrow(
      /retirement identity changed/,
    );
    expect(changed).toBe(true);
    await expectPreserved({ ...record, removedAt: removedAt + 1 });
  });

  it("refuses a retained-source symref retargeted to the retiring snapshot", async () => {
    await git(repo, "update-ref", request.retainedSourceRef, request.expectedSnapshotOid);
    const realGit = worktreeGit.requireGit;
    let retargeted = false;
    vi.spyOn(worktreeGit, "requireGit").mockImplementation(async (cwd, args, options) => {
      if (
        !retargeted &&
        args[0] === "update-ref" &&
        args.includes("--stdin") &&
        String(options?.input).includes(`delete ${record.snapshotRef} `)
      ) {
        retargeted = true;
        await git(repo, "symbolic-ref", request.retainedSourceRef, record.snapshotRef!);
      }
      return await realGit(cwd, args, options);
    });

    await expect(
      retireManagedWorktreeSnapshotById({
        ...request,
        expectedRetainedSourceOid: request.expectedSnapshotOid,
      }),
    ).rejects.toThrow(/multiple updates|cannot lock ref/);

    expect(retargeted).toBe(true);
    expect(getRegistryWorktree(env, record.id)).toEqual(record);
    expect(await git(repo, "rev-parse", "--verify", record.snapshotRef!)).toBe(
      request.expectedSnapshotOid,
    );
    expect(await git(repo, "symbolic-ref", request.retainedSourceRef)).toBe(record.snapshotRef);
    expect(await git(repo, "rev-parse", "--verify", request.retainedSourceRef)).toBe(
      request.expectedSnapshotOid,
    );
  });

  it("stops before deletion when caller authority is revoked after inspection", async () => {
    const realGit = worktreeGit.requireGit;
    let revoked = false;
    vi.spyOn(worktreeGit, "requireGit").mockImplementation(async (cwd, args, options) => {
      if (
        args[0] === "update-ref" &&
        args.includes("--stdin") &&
        String(options?.input).includes(`delete ${record.snapshotRef} `)
      ) {
        revoked = true;
      }
      return await realGit(cwd, args, options);
    });
    await expect(
      retireManagedWorktreeSnapshotById({
        ...request,
        commitGuard: () => {
          if (revoked) {
            throw new Error("caller authority revoked");
          }
        },
      }),
    ).rejects.toThrow("caller authority revoked");
    expect(revoked).toBe(true);
    await expectPreserved(record);
  });
});
