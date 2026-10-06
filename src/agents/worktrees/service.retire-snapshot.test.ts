import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerWorktreesCli } from "../../cli/worktrees-cli.js";
import { withLocalWorkspaceStore } from "../../gateway/worker-environments/local-workspace-store.js";
import {
  observeLocalWorkspaceStoreSql,
  readLocalWorkspaceProjection,
} from "../../gateway/worker-environments/local-workspace-store.test-support.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { defaultRuntime } from "../../runtime.js";
import * as stateRead from "../../state/openclaw-state-db-readonly.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import * as worktreeGit from "./git.js";
import { insertRegistryWorktreeProvisionedChunk } from "./provisioned-snapshot.test-support.js";
import { getRegistryWorktreeProvisionedChunk } from "./registry-read.js";
import { getRegistryWorktree, insertRegistryWorktree, updateRegistryWorktree } from "./registry.js";
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
    await insertRegistryWorktree(env, record, { provisionedPaths: [] });
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

  function beforeSnapshotDeletion(effect: () => void | Promise<void>) {
    const realGit = worktreeGit.requireGit;
    const mutation = vi.fn(effect);
    vi.spyOn(worktreeGit, "requireGit").mockImplementation(async (cwd, args, options) => {
      if (
        mutation.mock.calls.length === 0 &&
        args[0] === "update-ref" &&
        args.includes("--stdin") &&
        String(options?.input).includes(`delete ${record.snapshotRef} `)
      ) {
        await mutation();
      }
      return await realGit(cwd, args, options);
    });
    return mutation;
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

  it.each(["wrong", "exact"])(
    "enforces CLI snapshot custody when the timestamp is %s",
    async (timestamp) => {
      const cli = retirementCli();
      if (timestamp === "wrong") {
        cli.argv[cli.argv.indexOf("--removed-at") + 1] = String(removedAt + 1);
        await expect(cli.program.parseAsync(cli.argv)).rejects.toThrow(
          /snapshot identity does not match/,
        );
        expect(cli.output).not.toHaveBeenCalled();
        await expectPreserved(record);
        return;
      }
      const foreign: ManagedWorktreeRecord = {
        ...record,
        id: "a0000000-0000-4000-8000-000000000002",
        name: "foreign",
        path: path.join(root, "foreign"),
        branch: "openclaw/foreign",
        snapshotRef: "refs/openclaw/snapshots/a0000000-0000-4000-8000-000000000002",
      };
      await insertRegistryWorktree(env, foreign, { provisionedPaths: [] });
      await git(repo, "update-ref", foreign.snapshotRef!, source);
      const outcome = "refs/openclaw/pr-merge-outcomes/123";
      await git(repo, "update-ref", outcome, source);

      await cli.program.parseAsync(cli.argv);
      expect(cli.output).toHaveBeenCalledExactlyOnceWith({ retired: true, id: record.id });

      expect(getRegistryWorktree(env, record.id)).toBeUndefined();
      await expect(git(repo, "show-ref", "--verify", record.snapshotRef!)).rejects.toThrow();
      await expect(fs.lstat(record.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(getRegistryWorktree(env, foreign.id)).toEqual(foreign);
      expect(await git(repo, "rev-parse", foreign.snapshotRef!)).toBe(source);
      expect(await git(repo, "rev-parse", outcome)).toBe(source);
      expect(await git(repo, "rev-parse", request.retainedSourceRef)).toBe(source);
      expect(await git(repo, "show", "HEAD:README.md")).toBe("base");
    },
  );

  it.each([
    ["ID", { id: "a0000000-0000-4000-8000-000000000099" }],
    ["snapshot namespace", { expectedSnapshotRef: "refs/heads/main" }],
    ["snapshot OID", { expectedSnapshotOid: "1".repeat(40) }],
    ["retained source OID", { expectedRetainedSourceOid: "1".repeat(40) }],
    ["live registry lifecycle", {}],
    ["repository identity", {}],
  ] as const)("preserves custody when the expected %s does not match", async (label, patch) => {
    if (label === "live registry lifecycle") {
      await updateRegistryWorktree(env, record.id, { removedAt: undefined });
    } else if (label === "repository identity") {
      await updateRegistryWorktree(env, record.id, {
        repositoryIdentity: { repoRoot: repo, repoFingerprint: "foreign-fingerprint" },
      });
    }
    const expected =
      label === "live registry lifecycle" || label === "repository identity"
        ? getRegistryWorktree(env, record.id)
        : record;
    await expect(retireManagedWorktreeSnapshotById({ ...request, ...patch })).rejects.toThrow(
      label === "repository identity"
        ? /repository identity changed/
        : label === "live registry lifecycle"
          ? /snapshot identity does not match/
          : /snapshot identity does not match|ref OID changed/,
    );
    await expectPreserved(expected);
  });

  it("preserves exact-state recovery instead of treating it as a redundant ordinary snapshot", async () => {
    const exactRef = `refs/openclaw/snapshots/exact-v1/${record.id}`;
    await git(repo, "update-ref", exactRef, request.expectedSnapshotOid);
    await updateRegistryWorktree(env, record.id, { snapshotRef: exactRef });
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

  it.each(["dangling symlink", "Git registration"])(
    "preserves a reappeared checkout's %s",
    async (kind) => {
      const target = path.join(root, "missing-target");
      let registered = "";
      if (kind === "dangling symlink") {
        await fs.symlink(target, record.path);
      } else {
        await git(repo, "worktree", "add", "--detach", record.path, source);
        await fs.rm(record.path, { recursive: true });
        registered = await git(repo, "worktree", "list", "--porcelain");
        expect(registered).toContain(record.path);
      }
      await expect(retireManagedWorktreeSnapshotById(request)).rejects.toThrow(
        /checkout or Git registration/,
      );
      await expectPreserved(record);
      if (kind === "dangling symlink") {
        expect(await fs.readlink(record.path)).toBe(target);
      } else {
        expect(await git(repo, "worktree", "list", "--porcelain")).toBe(registered);
      }
    },
  );

  it.each(["unknown run", "removal"])("preserves a %s consumer", async (kind) => {
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

  it.each(["missing ledger", "provisioned ledger", "orphan chunk"])(
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
      } else if (kind === "provisioned ledger") {
        await updateRegistryWorktree(env, record.id, {
          provisionedState: [{ path: chunk.path, mode: 0o600, chunks: 1 }],
        });
        await insertRegistryWorktreeProvisionedChunk(env, { ...chunk, data: bytes });
      } else {
        await insertRegistryWorktreeProvisionedChunk(env, { ...chunk, data: bytes });
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

  it.each(["pending removal", "symbolic snapshot"])("preserves %s ref custody", async (kind) => {
    const pending = `refs/openclaw/removals/${record.id}`;
    const symbolic = kind === "symbolic snapshot";
    if (symbolic) {
      await git(repo, "update-ref", "-d", record.snapshotRef!);
      await git(repo, "symbolic-ref", record.snapshotRef!, request.retainedSourceRef);
    } else {
      await git(repo, "update-ref", pending, source);
    }
    await expect(
      retireManagedWorktreeSnapshotById({
        ...request,
        expectedSnapshotOid: symbolic ? source : request.expectedSnapshotOid,
      }),
    ).rejects.toThrow(symbolic ? /direct, not symbolic, refs/ : /pending removal custody/);
    if (symbolic) {
      expect(getRegistryWorktree(env, record.id)).toEqual(record);
      expect(await git(repo, "symbolic-ref", record.snapshotRef!)).toBe(request.retainedSourceRef);
      expect(await git(repo, "rev-parse", request.retainedSourceRef)).toBe(source);
    } else {
      await expectPreserved(record);
      expect(await git(repo, "rev-parse", pending)).toBe(source);
    }
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
    const row = await withLocalWorkspaceStore({ worktreeId: record.id, env }, (store) =>
      store.create({
        worktree_id: record.id,
        agent_id: "main",
        session_key: record.ownerId!,
        session_id: "b0000000-0000-4000-8000-000000000001",
        lifecycle_revision: null,
        projection_path: projection,
        base_commit: source,
        source_paths_json: JSON.stringify(["README.md"]),
        baseline_json: JSON.stringify({ synthetic: "x".repeat(3 * 1024 * 1024) }),
        baseline_ref: "sha256:" + "a".repeat(64),
        pending_ref: null,
        pending_target: null,
        journal_json: JSON.stringify({ synthetic: "j".repeat(3 * 1024 * 1024) }),
        journal_pack: Buffer.from("synthetic recovery pack"),
        paused_runtimes_json: null,
        created_at_ms: removedAt - 1,
      }),
    );
    expect(row.revision).toBe(0);
    const reads = observeLocalWorkspaceStoreSql();
    try {
      reads.calibrate();
      const executeRead = stateRead.executeExistingOpenClawStateRead;
      const projectionReplyBytes: number[] = [];
      const readReply = vi
        .spyOn(stateRead, "executeExistingOpenClawStateRead")
        .mockImplementation(async (options, command, readOptions) => {
          const reply = await executeRead(options, command, readOptions);
          if (command.type.startsWith("localWorkspace.")) {
            projectionReplyBytes.push(Buffer.byteLength(JSON.stringify(reply)));
          }
          return reply;
        });
      await expect(retireManagedWorktreeSnapshotById(request)).rejects.toThrow(
        /projection custody/,
      );
      readReply.mockRestore();
      expect(projectionReplyBytes.length).toBeGreaterThan(0);
      expect(Math.max(...projectionReplyBytes)).toBeLessThan(1024);
      reads.expectIdle();
    } finally {
      reads.restore();
    }
    await expectPreserved(record);
    expect(await readLocalWorkspaceProjection(record.id, env)).toEqual(row);
    expect(await fs.readFile(payload, "utf8")).toBe("projection-only content");
  });

  it.each(["content", "parent history"])(
    "preserves snapshot %s absent from the retained ref",
    async (kind) => {
      let snapshotTree = tree;
      let parent = source;
      if (kind === "content") {
        await fs.writeFile(path.join(repo, "README.md"), "unique snapshot bytes");
        await git(repo, "add", "README.md");
        snapshotTree = await git(repo, "write-tree");
      } else {
        parent = await git(repo, "commit-tree", tree, "-m", "unrelated history");
      }
      const snapshot = await git(
        repo,
        "commit-tree",
        snapshotTree,
        "-p",
        parent,
        "-m",
        "unretained",
      );
      await git(repo, "update-ref", record.snapshotRef!, snapshot);
      await expect(
        retireManagedWorktreeSnapshotById({ ...request, expectedSnapshotOid: snapshot }),
      ).rejects.toThrow(
        kind === "content" ? /source not covered by the retained commit/ : /merge-base/,
      );
      expect(getRegistryWorktree(env, record.id)).toEqual(record);
      expect(await git(repo, "rev-parse", record.snapshotRef!)).toBe(snapshot);
      if (kind === "content") {
        expect(await git(repo, "show", `${record.snapshotRef}:README.md`)).toBe(
          "unique snapshot bytes",
        );
      }
    },
  );

  it.each(["snapshot", "retained source", "pending removal", "retained symref"])(
    "rejects changed %s custody at the Git deletion boundary",
    async (kind) => {
      const symbolic = kind === "retained symref";
      const replacement = symbolic
        ? request.expectedSnapshotOid
        : await git(repo, "commit-tree", tree, "-p", source, "-m", "new snapshot");
      if (symbolic) {
        await git(repo, "update-ref", request.retainedSourceRef, replacement);
      }
      const target =
        kind === "snapshot"
          ? record.snapshotRef!
          : kind === "retained source" || symbolic
            ? request.retainedSourceRef
            : `refs/openclaw/removals/${record.id}`;
      const mutation = beforeSnapshotDeletion(async () => {
        if (symbolic) {
          await git(repo, "symbolic-ref", target, record.snapshotRef!);
        } else {
          await git(repo, "update-ref", target, replacement);
        }
      });
      await expect(
        retireManagedWorktreeSnapshotById({
          ...request,
          expectedRetainedSourceOid: symbolic ? replacement : source,
        }),
      ).rejects.toThrow(
        symbolic ? /multiple updates|cannot lock ref/ : /cannot lock ref|reference already exists/,
      );
      expect(mutation).toHaveBeenCalledOnce();
      expect(getRegistryWorktree(env, record.id)).toEqual(record);
      expect(await git(repo, "rev-parse", target)).toBe(replacement);
      expect(await git(repo, "rev-parse", "--verify", record.snapshotRef!)).toBe(
        kind === "snapshot" ? replacement : request.expectedSnapshotOid,
      );
      expect(await git(repo, "rev-parse", "--verify", request.retainedSourceRef)).toBe(
        kind === "retained source" || symbolic ? replacement : source,
      );
      if (symbolic) {
        expect(await git(repo, "symbolic-ref", request.retainedSourceRef)).toBe(record.snapshotRef);
      }
    },
  );

  it.each(["registry lifecycle", "caller authority"])(
    "rechecks %s at the deletion boundary",
    async (kind) => {
      let revoked = false;
      const mutation = beforeSnapshotDeletion(async () => {
        if (kind === "registry lifecycle") {
          await updateRegistryWorktree(env, record.id, { removedAt: removedAt + 1 });
        } else {
          revoked = true;
        }
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
      ).rejects.toThrow(
        kind === "caller authority" ? "caller authority revoked" : /retirement identity changed/,
      );
      expect(mutation).toHaveBeenCalledOnce();
      await expectPreserved(
        kind === "caller authority" ? record : { ...record, removedAt: removedAt + 1 },
      );
    },
  );
});
