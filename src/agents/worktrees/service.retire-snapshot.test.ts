import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerWorktreesCli } from "../../cli/worktrees-cli.js";
import { withLocalWorkspaceStore } from "../../gateway/worker-environments/local-workspace-store.js";
import {
  observeLocalWorkspaceStoreSql,
  localWorkspaceProjectionFixture,
  readLocalWorkspaceProjection,
} from "../../gateway/worker-environments/local-workspace-store.test-support.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { defaultRuntime } from "../../runtime.js";
import * as stateRead from "../../state/openclaw-state-db-readonly.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import * as worktreeGit from "./git.js";
import { insertRegistryWorktreeProvisionedChunk } from "./provisioned-snapshot.test-support.js";
import { getRegistryWorktreeProvisionedChunk } from "./registry-read.js";
import { insertRegistryWorktree, updateRegistryWorktree } from "./registry.js";
import { getRegistryWorktree } from "./registry.test-support.js";
import { resolveRepository } from "./repository-paths.js";
import { makeWorktreeRecord, useManagedWorktreeTestRepository } from "./service.test-support.js";
import { retireManagedWorktreeSnapshotById } from "./snapshot-host.js";
import type { ManagedWorktreeRecord } from "./types.js";

const execFileAsync = promisify(execFile);
const removedAt = 1_700_000_000_100;

describe("Exact removed worktree snapshot retirement", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  const tempDirs = useStateDatabaseTempDirs();
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  let root: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let record: ManagedWorktreeRecord;
  let request: Parameters<typeof retireManagedWorktreeSnapshotById>[0];
  let source: string;
  let tree: string;
  let snapshotRef: string;
  let snapshot: string;
  const retainedRef = "refs/heads/retained-source";
  const git = async (...args: string[]) =>
    (await execFileAsync("git", ["-C", repo, ...args])).stdout.trim();
  const registry = () => getRegistryWorktree(env, record.id);
  const retire = (patch: Partial<typeof request> = {}) =>
    retireManagedWorktreeSnapshotById({ ...request, ...patch });
  const commit = (message: string, commitTree = tree) =>
    git("commit-tree", commitTree, "-p", source, "-m", message);
  async function expectRef(ref: string, oid = source) {
    expect(await git("rev-parse", "--verify", ref)).toBe(oid);
  }
  async function reject(error: RegExp | string, patch: Partial<typeof request> = {}) {
    await expect(retire(patch)).rejects.toThrow(error);
  }

  beforeEach(async () => {
    root = tempDirs.make("openclaw-snapshot-retirement-");
    repo = await initializeRepository(root);
    const stateDir = path.join(root, "state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("GIT_NO_LAZY_FETCH", "1");
    vi.stubEnv("GIT_OPTIONAL_LOCKS", "0");
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    source = await git("rev-parse", "HEAD");
    tree = await git("rev-parse", "HEAD^{tree}");
    const repository = await resolveRepository(repo);
    const id = "a0000000-0000-4000-8000-000000000001";
    snapshotRef = `refs/openclaw/snapshots/${id}`;
    record = makeWorktreeRecord(repository.repoRoot, id, {
      name: "retired",
      repoFingerprint: repository.fingerprint,
      path: path.join(root, "retired"),
      branch: "openclaw/retired",
      baseRef: "main",
      ownerId: "agent:main:test:snapshot-retirement",
      createdAt: removedAt - 100,
      lastActiveAt: removedAt - 1,
      removedAt,
      snapshotRef,
    });
    snapshot = await commit("removed snapshot");
    await git("update-ref", snapshotRef, snapshot);
    await git("update-ref", retainedRef, source);
    await insertRegistryWorktree(env, record, { provisionedPaths: [] });
    const database = openOpenClawStateDatabase({ env });
    expect(await fs.realpath(database.path)).toBe(path.join(stateDir, "state", "openclaw.sqlite"));
    request = {
      id,
      expectedSnapshotRef: snapshotRef,
      expectedSnapshotOid: snapshot,
      expectedRemovedAt: removedAt,
      retainedSourceRef: retainedRef,
      expectedRetainedSourceOid: source,
    };
  });

  async function expectPreserved(expected: ManagedWorktreeRecord | undefined = record) {
    expect(registry()).toEqual(expected);
    await expectRef(snapshotRef, snapshot);
    await expectRef(retainedRef);
  }

  function beforeSnapshotDeletion(effect: () => void | Promise<void>) {
    const realGit = worktreeGit.requireGit;
    let pending = true;
    vi.spyOn(worktreeGit, "requireGit").mockImplementation(async (cwd, args, options) => {
      if (
        pending &&
        args[0] === "update-ref" &&
        args.includes("--stdin") &&
        String(options?.input).includes(`delete ${snapshotRef} `)
      ) {
        pending = false;
        await effect();
      }
      return await realGit(cwd, args, options);
    });
  }

  function retirementCli(patch: Record<string, string> = {}) {
    const program = new Command().name("openclaw").exitOverride();
    program.configureOutput({ writeErr: () => undefined });
    registerWorktreesCli(program);
    const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
    const options = {
      "--expected-ref": snapshotRef,
      "--expected-oid": snapshot,
      "--removed-at": String(removedAt),
      "--retained-ref": retainedRef,
      "--retained-oid": source,
      ...patch,
    };
    const argv = ["node", "openclaw", "worktrees", "retire-snapshot", record.id];
    argv.push(...Object.entries(options).flat(), "--json");
    return { program, output, argv };
  }

  it.each([
    ["timestamp", "--removed-at", /snapshot identity does not match/],
    ["snapshot OID", "--expected-oid", /snapshot identity does not match|ref OID changed/],
    ["repository identity", "", /repository identity changed/],
  ] as const)("enforces CLI snapshot custody (%s)", async (kind, flag, error) => {
    if (kind === "repository identity") {
      await updateRegistryWorktree(env, record.id, {
        repositoryIdentity: { repoRoot: repo, repoFingerprint: "foreign-fingerprint" },
      });
    }
    const cli = retirementCli(
      flag ? { [flag]: kind === "timestamp" ? String(removedAt + 1) : "1".repeat(40) } : {},
    );
    const expected = kind === "repository identity" ? registry() : record;
    await expect(cli.program.parseAsync(cli.argv)).rejects.toThrow(error);
    expect(cli.output).not.toHaveBeenCalled();
    await expectPreserved(expected);
  });

  it("retires only the exact CLI snapshot", async () => {
    const cli = retirementCli();
    const foreign: ManagedWorktreeRecord = {
      ...record,
      id: "a0000000-0000-4000-8000-000000000002",
      name: "foreign",
      path: path.join(root, "foreign"),
      branch: "openclaw/foreign",
      snapshotRef: "refs/openclaw/snapshots/a0000000-0000-4000-8000-000000000002",
    };
    await insertRegistryWorktree(env, foreign, { provisionedPaths: [] });
    await git("update-ref", foreign.snapshotRef!, source);
    const outcome = "refs/openclaw/pr-merge-outcomes/123";
    await git("update-ref", outcome, source);

    await cli.program.parseAsync(cli.argv);
    expect(cli.output).toHaveBeenCalledExactlyOnceWith({ retired: true, id: record.id });

    expect(registry()).toBeUndefined();
    await expect(git("show-ref", "--verify", snapshotRef)).rejects.toThrow();
    await expect(fs.lstat(record.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(getRegistryWorktree(env, foreign.id)).toEqual(foreign);
    for (const ref of [foreign.snapshotRef!, outcome, retainedRef]) {
      await expectRef(ref);
    }
    expect(await git("show", "HEAD:README.md")).toBe("base");
  });

  it("preserves exact-state recovery instead of treating it as a redundant ordinary snapshot", async () => {
    const exactRef = `refs/openclaw/snapshots/exact-v1/${record.id}`;
    await git("update-ref", exactRef, snapshot);
    await updateRegistryWorktree(env, record.id, { snapshotRef: exactRef });
    const exactRecord = registry();
    const recovery = path.join(root, "exact-recovery");
    await git("worktree", "add", "--detach", recovery, source);
    await fs.writeFile(path.join(recovery, "newer.txt"), "write after capture");
    const registrations = await git("worktree", "list", "--porcelain");

    await reject(/Invalid exact snapshot retirement identity/, { expectedSnapshotRef: exactRef });

    expect(registry()).toEqual(exactRecord);
    await expectRef(exactRef, snapshot);
    expect(await fs.readFile(path.join(recovery, "newer.txt"), "utf8")).toBe("write after capture");
    expect(await git("worktree", "list", "--porcelain")).toBe(registrations);
    await expectRef(retainedRef);
  });

  it("preserves a reappeared checkout's Git registration", async () => {
    await git("worktree", "add", "--detach", record.path, source);
    await fs.rm(record.path, { recursive: true });
    const registered = await git("worktree", "list", "--porcelain");
    expect(registered).toContain(record.path);
    await reject(/checkout or Git registration/);
    await expectPreserved();
    expect(await git("worktree", "list", "--porcelain")).toBe(registered);
  });

  it("preserves an unknown run consumer", async () => {
    const scope = `worktree-run:${record.id}`;
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const query = getNodeSqliteKysely<Pick<DB, "state_leases">>(db);
        executeSqliteQuerySync(
          db,
          query.insertInto("state_leases").values({
            scope,
            lease_key: "retained-run",
            owner: "synthetic-consumer",
            payload_json: JSON.stringify({}),
            created_at: removedAt,
            updated_at: removedAt,
          }),
        );
      },
      { env },
    );
    await reject(/run\/removal consumer/);
    await expectPreserved();
    const { db } = openOpenClawStateDatabase({ env });
    const leaseQuery = getNodeSqliteKysely<Pick<DB, "state_leases">>(db);
    expect(
      executeSqliteQuerySync(
        db,
        leaseQuery.selectFrom("state_leases").select("owner").where("scope", "=", scope),
      ).rows,
    ).toEqual([{ owner: "synthetic-consumer" }]);
  });

  it.each(["missing ledger", "provisioned ledger"])(
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
      } else {
        await updateRegistryWorktree(env, record.id, {
          provisionedState: [{ path: chunk.path, mode: 0o600, chunks: 1 }],
        });
        await insertRegistryWorktreeProvisionedChunk(env, { ...chunk, data: bytes });
      }
      await expect(retireManagedWorktreeSnapshotById(request)).rejects.toThrow(
        /retains provisioned data/,
      );
      await expectPreserved(record);
      if (kind === "provisioned ledger") {
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
      await git("update-ref", "-d", snapshotRef);
      await git("symbolic-ref", snapshotRef, retainedRef);
    } else {
      await git("update-ref", pending, source);
    }
    await reject(symbolic ? /direct, not symbolic, refs/ : /pending removal custody/, {
      expectedSnapshotOid: symbolic ? source : snapshot,
    });
    if (symbolic) {
      expect(registry()).toEqual(record);
      expect(await git("symbolic-ref", snapshotRef)).toBe(retainedRef);
      await expectRef(retainedRef);
    } else {
      await expectPreserved();
      await expectRef(pending);
    }
  });

  it("preserves projection custody and ignored bytes that Git equality cannot cover", async () => {
    const fixture = localWorkspaceProjectionFixture(
      record.id,
      path.join(env.OPENCLAW_STATE_DIR!, "worktree-projections"),
    );
    const projection = fixture.projection_path;
    await fs.mkdir(projection, { recursive: true });
    const payload = path.join(projection, "ignored-owned.txt");
    await fs.writeFile(payload, "projection-only content");
    const row = await withLocalWorkspaceStore({ worktreeId: record.id, env }, (store) =>
      store.create({
        ...fixture,
        session_key: record.ownerId!,
        base_commit: source,
        source_paths_json: JSON.stringify(["README.md"]),
        baseline_json: JSON.stringify({ synthetic: "x".repeat(3 * 1024 * 1024) }),
        baseline_ref: "sha256:" + "a".repeat(64),
        journal_json: JSON.stringify({ synthetic: "j".repeat(3 * 1024 * 1024) }),
        journal_pack: Buffer.from("synthetic recovery pack"),
      }),
    );
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
      await reject(/projection custody/);
      readReply.mockRestore();
      expect(projectionReplyBytes.length).toBeGreaterThan(0);
      expect(Math.max(...projectionReplyBytes)).toBeLessThan(1024);
      reads.expectIdle();
    } finally {
      reads.restore();
    }
    await expectPreserved();
    expect(await readLocalWorkspaceProjection(record.id, env)).toEqual(row);
    expect(await fs.readFile(payload, "utf8")).toBe("projection-only content");
  });

  it("preserves snapshot content absent from the retained ref", async () => {
    await fs.writeFile(path.join(repo, "README.md"), "unique snapshot bytes");
    await git("add", "README.md");
    const snapshotTree = await git("write-tree");
    const unique = await commit("unretained", snapshotTree);
    await git("update-ref", snapshotRef, unique);
    await reject(/source not covered by the retained commit/, { expectedSnapshotOid: unique });
    expect(registry()).toEqual(record);
    await expectRef(snapshotRef, unique);
    expect(await git("show", `${snapshotRef}:README.md`)).toBe("unique snapshot bytes");
  });

  it.each(["snapshot", "retained source", "pending removal", "retained symref"])(
    "rejects changed %s custody at the Git deletion boundary",
    async (kind) => {
      const symbolic = kind === "retained symref";
      const replacement = symbolic ? snapshot : await commit("new snapshot");
      if (symbolic) {
        await git("update-ref", retainedRef, replacement);
      }
      const target =
        kind === "snapshot"
          ? snapshotRef
          : kind === "retained source" || symbolic
            ? retainedRef
            : `refs/openclaw/removals/${record.id}`;
      beforeSnapshotDeletion(async () => {
        if (symbolic) {
          await git("symbolic-ref", target, snapshotRef);
        } else {
          await git("update-ref", target, replacement);
        }
      });
      await reject(
        symbolic ? /multiple updates|cannot lock ref/ : /cannot lock ref|reference already exists/,
        { expectedRetainedSourceOid: symbolic ? replacement : source },
      );
      expect(registry()).toEqual(record);
      await expectRef(target, replacement);
      await expectRef(snapshotRef, kind === "snapshot" ? replacement : snapshot);
      await expectRef(retainedRef, kind === "retained source" || symbolic ? replacement : source);
      if (symbolic) {
        expect(await git("symbolic-ref", retainedRef)).toBe(snapshotRef);
      }
    },
  );

  it.each(["registry lifecycle", "caller authority"])(
    "rechecks %s at the deletion boundary",
    async (kind) => {
      let revoked = false;
      beforeSnapshotDeletion(async () => {
        if (kind === "registry lifecycle") {
          await updateRegistryWorktree(env, record.id, { removedAt: removedAt + 1 });
        } else {
          revoked = true;
        }
      });
      await reject(
        kind === "caller authority" ? "caller authority revoked" : /retirement identity changed/,
        {
          commitGuard: () => {
            if (revoked) {
              throw new Error("caller authority revoked");
            }
          },
        },
      );
      await expectPreserved(
        kind === "caller authority" ? record : { ...record, removedAt: removedAt + 1 },
      );
    },
  );
});
