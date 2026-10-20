import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { insertRegistryWorktree } from "../../agents/worktrees/registry.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveExecutablePath } from "../../infra/executable-path.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import * as execRunner from "../../process/exec-runner.js";
import { captureSessionDiffBaseline } from "../../sessions/session-diff.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withLocalWorkspaceStore } from "../worker-environments/local-workspace-store.js";
import {
  localWorkspaceProjectionFixture,
  observeLocalWorkspaceStoreSql,
} from "../worker-environments/local-workspace-store.test-support.js";
import { loadSessionDiff, sessionsDiffHandlers } from "./sessions-diff.js";
import { git, initRepo, fixedStoreConfig } from "./sessions-diff.test-support.js";

const hoisted = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  patchSessionEntryCore: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
}));

// mock-isolation: Diff RPC cases supply session discovery while exercising real Git reads.
vi.mock("../session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: (params: { key: string; agentId?: string }) =>
    hoisted.loadSessionEntry(params.key, { agentId: params.agentId }),
}));

vi.mock("../../config/sessions/session-entry-read-facts.js", async (importOriginal) => {
  const { createRepositorySessionEntryReader } =
    await import("./sessions-files.repository.test-support.js");
  const actual =
    await importOriginal<typeof import("../../config/sessions/session-entry-read-facts.js")>();
  return {
    ...actual,
    readRetainedSessionEntryFacts: createRepositorySessionEntryReader(
      actual.readRetainedSessionEntryFacts,
      (key) => hoisted.loadSessionEntry(key),
    ),
  };
});

vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  resolveAgentWorkspaceDir: hoisted.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: hoisted.resolveDefaultAgentId,
}));

// mock-isolation: Diff RPC cases control session persistence independently of throwaway Git repos.
vi.mock("../../config/sessions/session-accessor.js", () => ({
  patchSessionEntryCore: hoisted.patchSessionEntryCore,
}));

function mockSession(spawnedCwd: string, entry: Record<string, unknown> = {}): void {
  hoisted.loadSessionEntry.mockReturnValue({
    agentId: "main",
    cfg: {},
    entry: { sessionId: "s1", spawnedCwd, ...entry },
    storePath: "/tmp/sessions.json",
    canonicalKey: "agent:main:s1",
  });
}

async function requestDiff(
  params: Record<string, unknown>,
  cfg: OpenClawConfig = {},
  reqParams: Record<string, unknown> = {},
) {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  await sessionsDiffHandlers["sessions.diff"]?.({
    req: { type: "req", id: "sessions.diff", method: "sessions.diff", params: reqParams },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => calls.push({ ok, payload, error }),
    context: {
      getRuntimeConfig: () => cfg,
      logGateway: createSubsystemLogger("test/sessions-diff"),
    } as never,
  });
  return calls;
}

describe("loadSessionDiff", () => {
  let repoRoot: string;
  let tempDirs: string[];
  const tempDir = (prefix: string) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    tempDirs.push(dir);
    return dir;
  };
  const repoGit = (...args: string[]) => git(repoRoot, ...args);
  const readDiff = (params: Omit<Parameters<typeof loadSessionDiff>[0], "sessionKey"> = {}) =>
    loadSessionDiff({ sessionKey: "agent:main:s1", ...params });
  const baseline = (sessionId = "s1", cwd = repoRoot) =>
    captureSessionDiffBaseline({ cwd, sessionId });
  const write = (name: string, data: string | Buffer) =>
    fs.writeFileSync(path.join(repoRoot, name), data);
  const append = (name: string, data: string) => fs.appendFileSync(path.join(repoRoot, name), data);
  const commitFiles = (message = "init", files = ".") => {
    repoGit("add", files);
    repoGit("commit", "-qm", message);
  };
  const revision = (ref = "HEAD", short = false) =>
    repoGit("rev-parse", ...(short ? ["--short"] : []), ref).trim();
  const useBaseline = async (sessionId = "s1", cwd = repoRoot) => {
    const captured = await baseline(sessionId, cwd);
    mockSession(cwd, { sessionDiffBaseline: captured });
    return captured;
  };
  const filePaths = (result: { files: Array<{ path: string }> } | undefined) =>
    result?.files.map((file) => file.path);
  const addedFile = (name: string, additions: number, flags: Record<string, boolean>) => ({
    path: name,
    status: "added",
    additions,
    deletions: 0,
    untracked: true,
    ...flags,
  });

  const initFiles = (files: Record<string, string | Buffer>, format?: "sha1" | "sha256") => {
    initRepo(repoRoot, format);
    for (const [name, data] of Object.entries(files)) {
      write(name, data);
    }
  };
  const seedRepo = (
    files: Record<string, string | Buffer>,
    subject = "init",
    format?: "sha1" | "sha256",
  ) => {
    initFiles(files, format);
    commitFiles(subject);
  };
  beforeEach(() => {
    setRuntimeConfigSnapshot({});
    vi.clearAllMocks();
    tempDirs = [];
    repoRoot = tempDir("openclaw-sessions-diff-");
    hoisted.resolveDefaultAgentId.mockReturnValue("main");
    hoisted.resolveAgentWorkspaceDir.mockReturnValue(repoRoot);
    mockSession(repoRoot);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    clearRuntimeConfigSnapshot();
  });

  it("reports unknown sessions without touching a workspace", async () => {
    hoisted.loadSessionEntry.mockReturnValue({
      agentId: "main",
      cfg: {},
      entry: undefined,
      storePath: "/tmp/sessions.json",
      canonicalKey: "agent:main:missing",
    });
    const result = await loadSessionDiff({ sessionKey: "agent:main:missing" });
    expect(result).toMatchObject({ unavailableReason: "unknown_session", files: [] });
  });

  it("keeps pending checkouts separate from the agent workspace", async () => {
    initFiles({ "AGENTS.md": "Agent workspace bootstrap\n" });
    mockSession(repoRoot, {
      spawnedCwd: undefined,
      pendingProjectGitUrl: "https://github.com/example/project.git",
    });
    expect(await readDiff()).toEqual({
      sessionKey: "agent:main:s1",
      files: [],
      additions: 0,
      deletions: 0,
    });
  });

  it.skipIf(process.platform === "win32")(
    "never executes a checkout-configured core.fsmonitor command",
    async () => {
      initFiles({ "a.txt": "one\n" });
      commitFiles("init", "a.txt");
      write("a.txt", "two\n");
      const outside = tempDir("openclaw-fsmonitor-");
      const sentinel = path.join(outside, "sentinel");
      const hook = path.join(outside, "fsmonitor.sh");
      fs.writeFileSync(hook, `#!/bin/sh\n: > "${sentinel}"\nexit 1\n`, { mode: 0o755 });
      repoGit("config", "core.fsmonitor", hook);
      // Sanity: unpinned git in this checkout does run the command.
      repoGit("status", "--porcelain");
      expect(fs.existsSync(sentinel)).toBe(true);
      fs.rmSync(sentinel);

      const diff = await readDiff();
      expect(filePaths(diff)).toEqual(["a.txt"]);
      const captured = await baseline();
      expect(filePaths(captured)).toEqual(["a.txt"]);
      expect(fs.existsSync(sentinel)).toBe(false);
    },
  );

  it("uses the persisted fixed-store owner for a bare session checkout", async () => {
    initFiles({ "owned.txt": "ops\n" });
    const cfg = fixedStoreConfig();
    setRuntimeConfigSnapshot(cfg);
    hoisted.loadSessionEntry.mockReturnValue({
      agentId: "ops",
      cfg,
      entry: { sessionId: "sess-owned-global" },
      storePath: cfg.session.store,
      canonicalKey: "global",
    });
    hoisted.resolveAgentWorkspaceDir.mockImplementation((_cfg: unknown, agentId: string) =>
      agentId === "ops" ? repoRoot : "/wrong/research",
    );
    const calls = await requestDiff({ sessionKey: "global" }, cfg);
    expect(calls).toMatchObject([{ ok: true, payload: { root: repoRoot } }]);
    expect(hoisted.loadSessionEntry).toHaveBeenCalledWith(
      "global",
      expect.objectContaining({ agentId: "ops" }),
    );
    expect(hoisted.resolveAgentWorkspaceDir).toHaveBeenCalledWith(cfg, "ops");
  });

  it("rejects a foreign agent before loading a bare fixed-store checkout", async () => {
    const cfg = fixedStoreConfig();
    setRuntimeConfigSnapshot(cfg);
    const calls = await requestDiff({ sessionKey: "global", agentId: "research" }, cfg);
    expect(calls).toMatchObject([
      {
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: 'agent "research" does not match session key agent "ops"',
        },
      },
    ]);
    expect(hoisted.loadSessionEntry).not.toHaveBeenCalled();
  });

  it("keeps tracked counts while omitting patches above the total changed-line limit", async () => {
    seedRepo({ "large.txt": "before\n", "small.txt": "before\n" }, "init");
    write("large.txt", "after\n".repeat(100_001));
    write("small.txt", "after\n");

    const runCommand = execRunner.runCommandBuffersWithTimeout;
    let trackedDiffCommands = 0;
    vi.spyOn(execRunner, "runCommandBuffersWithTimeout").mockImplementation((argv, options) => {
      if (
        argv[argv.indexOf("-C") + 1] === repoRoot &&
        argv.includes("diff") &&
        !argv.includes("--no-index")
      ) {
        trackedDiffCommands++;
      }
      return runCommand(argv, options);
    });
    const result = await readDiff();
    expect(result.files).toEqual([
      {
        path: "large.txt",
        status: "modified",
        additions: 100_001,
        deletions: 1,
        truncated: true,
      },
      { path: "small.txt", status: "modified", additions: 1, deletions: 1, truncated: true },
    ]);
    expect(result).toMatchObject({ additions: 100_002, deletions: 2 });
    expect(trackedDiffCommands).toBeLessThanOrEqual(1);
  });

  it.each([
    { kind: "tracked", flag: "--numstat" },
    { kind: "untracked", flag: "ls-files" },
  ])("reports a failed $kind inventory instead of an empty diff", async ({ kind, flag }) => {
    seedRepo({ "tracked.txt": "before\n" }, "init");
    write("tracked.txt", "after\n");
    const runCommand = execRunner.runCommandBuffersWithTimeout;
    vi.spyOn(execRunner, "runCommandBuffersWithTimeout").mockImplementation(
      async (argv, options) => {
        const result = await runCommand(argv, options);
        return argv[argv.indexOf("-C") + 1] === repoRoot && argv.includes(flag)
          ? { ...result, code: 1, stdout: Buffer.alloc(0) }
          : result;
      },
    );
    await expect(readDiff()).rejects.toThrow("Unable to read " + kind + " Git changes");
  });

  it("returns session-filtered summary counts without patches or branch history", async () => {
    initRepo(repoRoot);
    for (const [name, content] of [
      ["changed.txt", "before\n"],
      ["deleted.txt", "remove\nthese\n"],
      ["renamed.txt", "keep\nthese\nlines\n"],
      ["preexisting.txt", "existing\n"],
    ] as const) {
      fs.writeFileSync(path.join(repoRoot, name), content);
    }
    git(repoRoot, "add", ".");
    git(repoRoot, "commit", "-qm", "base");
    git(repoRoot, "checkout", "-qb", "feature");
    fs.appendFileSync(path.join(repoRoot, "preexisting.txt"), "before session\n");
    const summaryBaseline = await captureSessionDiffBaseline({ cwd: repoRoot, sessionId: "s1" });
    fs.writeFileSync(path.join(repoRoot, "committed.txt"), "branch\n");
    git(repoRoot, "add", "committed.txt");
    git(repoRoot, "commit", "-qm", "branch work");
    fs.writeFileSync(path.join(repoRoot, "changed.txt"), "after\nmore\n");
    git(repoRoot, "add", "changed.txt");
    git(repoRoot, "mv", "renamed.txt", "renamed-next.txt");
    fs.rmSync(path.join(repoRoot, "deleted.txt"));
    fs.writeFileSync(path.join(repoRoot, "loose file.txt"), "new\nlines\n");
    fs.writeFileSync(path.join(repoRoot, "binary.bin"), Buffer.from([0, 1, 2]));
    mockSession(repoRoot, { sessionDiffBaseline: summaryBaseline });
    const commands: string[][] = [];
    const runCommand = execRunner.runCommandBuffersWithTimeout;
    const observer = vi
      .spyOn(execRunner, "runCommandBuffersWithTimeout")
      .mockImplementation((argv, options) => {
        if (argv[argv.indexOf("-C") + 1] === repoRoot) {
          commands.push([...argv]);
        }
        return runCommand(argv, options);
      });
    onTestFinished(() => observer.mockRestore());

    const result = await loadSessionDiff({ sessionKey: "agent:main:s1", summaryOnly: true });

    expect(result.files).toEqual([
      {
        path: "binary.bin",
        status: "added",
        additions: 0,
        deletions: 0,
        untracked: true,
        binary: true,
      },
      { path: "changed.txt", status: "modified", additions: 2, deletions: 1 },
      { path: "committed.txt", status: "added", additions: 1, deletions: 0 },
      { path: "deleted.txt", status: "deleted", additions: 0, deletions: 2 },
      { path: "loose file.txt", status: "added", additions: 2, deletions: 0, untracked: true },
      {
        path: "renamed-next.txt",
        oldPath: "renamed.txt",
        status: "renamed",
        additions: 0,
        deletions: 0,
      },
    ]);
    expect(result.additions).toBe(5);
    expect(result.deletions).toBe(3);
    expect(result.commits).toBeUndefined();
    expect(result.mergeBase).toBeUndefined();
    expect(result.truncated).toBeUndefined();
    expect(commands.some((argv) => argv.includes("--numstat"))).toBe(true);
    expect(commands.some((argv) => argv.includes("--patch") || argv.includes("log"))).toBe(false);
  });

  it("shows an unrelated root commit merged into the feature branch in a sha256 repository", async () => {
    seedRepo({ "base.txt": "base\n" }, "base", "sha256");
    repoGit("checkout", "--orphan", "imported", "-q");
    repoGit("rm", "-rf", ".");
    write("imported.txt", "imported root\n");
    commitFiles("imported root");
    const rootCommit = revision();
    repoGit("checkout", "-qb", "feature", "main");
    repoGit("merge", "--allow-unrelated-histories", "--no-edit", "imported");
    append("imported.txt", "working tree edit\n");
    const result = await readDiff({ scope: "commit", commit: rootCommit });
    expect(result.unavailableReason).toBeUndefined();
    expect(filePaths(result)).toEqual(["imported.txt"]);
    expect(result.files[0]).toMatchObject({ status: "added", additions: 1, deletions: 0 });
    expect(result.files[0]?.patch).toContain("+imported root");
    expect(result.files[0]?.patch).not.toContain("working tree edit");
  });

  it("scopes branch, working-tree, and commit diffs against origin/master with branch metadata", async () => {
    const baseRef = "origin/master";

    seedRepo({ "base.txt": "base\n" }, "base");
    const mergeBase = revision();
    repoGit("checkout", "-qb", "sibling");
    write("sibling.txt", "sibling commit\n");
    commitFiles("sibling change");
    const siblingCommit = revision();
    repoGit("checkout", "-q", "main");
    repoGit("checkout", "-qb", "feature");
    repoGit("update-ref", `refs/remotes/${baseRef}`, mergeBase);
    repoGit("branch", "-d", "main");

    write("first.txt", "first commit\n");
    commitFiles("first change");
    const firstCommit = revision();
    write("second.txt", "second commit\n");
    commitFiles("second change");
    const secondCommit = revision();

    append("second.txt", "working tree\n");
    write("loose.txt", "untracked\n");
    const all = await readDiff();
    expect(all).toMatchObject({ baseRef, aheadCount: 2 });
    expect(filePaths(all)).toEqual(["first.txt", "loose.txt", "second.txt"]);
    expect(all.commits).toEqual([
      { sha: revision(secondCommit, true), subject: "second change" },
      { sha: revision(firstCommit, true), subject: "first change" },
    ]);
    expect(all.mergeBase).toEqual({
      sha: revision(mergeBase, true),
      subject: "base",
    });
    const uncommitted = await readDiff({ scope: "uncommitted" });
    expect(filePaths(uncommitted)).toEqual(["loose.txt", "second.txt"]);
    expect(uncommitted.files.find((file) => file.path === "second.txt")?.patch).toContain(
      "+working tree",
    );

    await useBaseline();
    const committed = await readDiff({ scope: "commit", commit: firstCommit });
    expect(filePaths(committed)).toEqual(["first.txt"]);
    expect(committed.files[0]?.patch).toContain("+first commit");
    expect(committed.files[0]?.untracked).toBeUndefined();

    for (const commit of [siblingCommit, mergeBase, "not-a-commit"]) {
      expect(await readDiff({ scope: "commit", commit })).toMatchObject({
        unavailableReason: "unknown_commit",
        files: [],
      });
    }
  });

  it("uses the accepted managed base for working, committed, and archived reads", async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-review-base-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateRoot);
    const id = randomUUID();
    const sessionKey = "agent:main:s1";
    try {
      openOpenClawStateDatabase();
      initRepo(repoRoot);
      fs.writeFileSync(path.join(repoRoot, "base.txt"), "base\n");
      git(repoRoot, "add", ".");
      git(repoRoot, "commit", "-qm", "original base");
      const staleBase = git(repoRoot, "rev-parse", "HEAD").trim();
      git(repoRoot, "update-ref", "refs/remotes/origin/main", staleBase);
      git(repoRoot, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
      fs.writeFileSync(path.join(repoRoot, "upstream.txt"), "upstream only\n");
      git(repoRoot, "add", ".");
      git(repoRoot, "commit", "-qm", "accepted upstream");
      const acceptedBase = git(repoRoot, "rev-parse", "HEAD").trim();
      git(repoRoot, "checkout", "-qb", "task");
      const worktree = { id, repoRoot, branch: "task" };
      await insertRegistryWorktree(process.env, {
        ...worktree,
        name: "review",
        repoFingerprint: "review-fixture",
        path: repoRoot,
        baseRef: "main",
        ownerKind: "session",
        ownerId: sessionKey,
        createdAt: 0,
        lastActiveAt: 0,
      });
      await withLocalWorkspaceStore({ worktreeId: id }, (store) =>
        store.create({
          ...localWorkspaceProjectionFixture(id, stateRoot),
          session_key: sessionKey,
          session_id: "s1",
          base_commit: acceptedBase,
        }),
      );
      mockSession(repoRoot, { worktree });
      fs.writeFileSync(path.join(repoRoot, "task.txt"), "authored change\n");
      using cleanup = new DisposableStack();
      const sql = observeLocalWorkspaceStoreSql();
      cleanup.defer(sql.restore);
      sql.calibrate();
      const beforePublication = await loadSessionDiff({ sessionKey });
      sql.expectIdle();
      expect(beforePublication.files.map((file) => file.path)).toEqual(["task.txt"]);
      expect(beforePublication).toMatchObject({
        additions: 1,
        deletions: 0,
        baseRef: acceptedBase,
      });
      const summary = await loadSessionDiff({ sessionKey, summaryOnly: true });
      expect(summary.files).toEqual([
        { path: "task.txt", status: "added", additions: 1, deletions: 0, untracked: true },
      ]);
      expect(summary).toMatchObject({ additions: 1, deletions: 0, baseRef: acceptedBase });
      expect(summary.commits).toBeUndefined();
      expect(
        (await loadSessionDiff({ sessionKey, scope: "uncommitted" })).files.map(
          (file) => file.path,
        ),
      ).toEqual(["task.txt"]);
      git(repoRoot, "add", "task.txt");
      git(repoRoot, "commit", "-qm", "publish task");
      const taskCommit = git(repoRoot, "rev-parse", "HEAD").trim();
      const afterPublication = await loadSessionDiff({ sessionKey });
      expect(afterPublication.files).toEqual(
        beforePublication.files.map(({ untracked: _untracked, ...file }) => file),
      );
      expect(afterPublication).toMatchObject({ additions: 1, deletions: 0, aheadCount: 1 });
      expect(afterPublication.commits?.map((commit) => commit.subject)).toEqual(["publish task"]);
      expect(afterPublication.mergeBase?.subject).toBe("accepted upstream");
      const uncommitted = await loadSessionDiff({ sessionKey, scope: "uncommitted" });
      expect(uncommitted.files).toEqual([]);
      expect(uncommitted).toMatchObject({ baseRef: acceptedBase, aheadCount: 1 });
      expect(uncommitted.commits).toEqual(afterPublication.commits);
      expect(
        (await loadSessionDiff({ sessionKey, scope: "commit", commit: acceptedBase }))
          .unavailableReason,
      ).toBe("unknown_commit");
      fs.appendFileSync(path.join(repoRoot, "task.txt"), "follow-up change\n");
      git(repoRoot, "add", "task.txt");
      git(repoRoot, "commit", "-qm", "follow-up task");
      const followUpCommit = git(repoRoot, "rev-parse", "HEAD").trim();
      const committed = await loadSessionDiff({
        sessionKey,
        scope: "commit",
        commit: followUpCommit,
      });
      expect(committed.files.map((file) => file.path)).toEqual(["task.txt"]);
      expect(committed).toMatchObject({ additions: 1, deletions: 0, aheadCount: 2 });
      expect(committed.commits?.map((commit) => commit.subject)).toEqual([
        "follow-up task",
        "publish task",
      ]);
      expect(committed.files[0]?.patch).toContain("+follow-up change");
      expect(committed.files[0]?.patch).not.toContain("+authored change");
      expect(git(repoRoot, "rev-parse", `${followUpCommit}^`).trim()).toBe(taskCommit);
      mockSession(repoRoot, { worktree, archivedAt: 1 });
      const archived = await loadSessionDiff({ sessionKey });
      expect(archived.files.map((file) => file.path)).toEqual(["task.txt"]);
      expect(archived).toMatchObject({ additions: 2, deletions: 0, aheadCount: 2 });
      for (const patch of [
        { agent_id: "other" },
        { session_key: "agent:main:other" },
        { session_id: "replaced" },
      ]) {
        await withLocalWorkspaceStore({ worktreeId: id }, (store) =>
          store.update(store.get()!, patch),
        );
        await expect(loadSessionDiff({ sessionKey })).rejects.toThrow(/workspace.*incarnation/i);
        await withLocalWorkspaceStore({ worktreeId: id }, (store) =>
          store.update(store.get()!, {
            agent_id: "main",
            session_key: sessionKey,
            session_id: "s1",
          }),
        );
      }
      mockSession(path.dirname(repoRoot), { worktree, archivedAt: 1 });
      await expect(loadSessionDiff({ sessionKey })).rejects.toThrow(
        "Local workspace review owner changed",
      );
      mockSession(repoRoot, { worktree, archivedAt: 1 });
      await withLocalWorkspaceStore({ worktreeId: id }, (store) => store.delete(store.get()!));
      expect((await loadSessionDiff({ sessionKey })).files.map((file) => file.path)).toEqual([
        "task.txt",
        "upstream.txt",
      ]);
    } finally {
      await closeOpenClawStateDatabaseAsync();
      vi.unstubAllEnvs();
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("never executes configured textconv drivers from the read RPC", async () => {
    seedRepo({ ".gitattributes": "*.txt diff=evil\n", "a.txt": "one\n" }, "init");
    const marker = path.join(repoRoot, "pwned");
    repoGit("config", "diff.evil.textconv", `touch ${marker}; cat`);
    write("a.txt", "one\ntwo\n");
    write("untracked.txt", "new\n");
    const result = await readDiff();
    expect(fs.existsSync(marker)).toBe(false);
    const tracked = result.files.find((file) => file.path === "a.txt");
    expect(tracked?.patch).toContain("+two");
  });

  it("withholds patch content for hardlinked files pointing outside the checkout", async () => {
    const secretDir = tempDir("openclaw-secret-");
    const secretFile = path.join(secretDir, "secret.txt");
    fs.writeFileSync(secretFile, "TOP SECRET VALUE\n");
    seedRepo({ "seed.txt": "seed\n" }, "init");
    fs.linkSync(secretFile, path.join(repoRoot, "leak.txt"));
    write("tracked.txt", "original\n");
    commitFiles("add tracked", "tracked.txt");
    fs.rmSync(path.join(repoRoot, "tracked.txt"));
    fs.linkSync(secretFile, path.join(repoRoot, "tracked.txt"));
    const result = await readDiff();
    expect(JSON.stringify(result)).not.toContain("TOP SECRET VALUE");
    for (const name of ["leak.txt", "tracked.txt"]) {
      const file = result.files.find((entry) => entry.path === name);
      expect(file?.patch).toBeUndefined();
      expect(file?.truncated).toBe(true);
    }
  });

  it("reports staged files and filters the session baseline before the first sha256 commit", async () => {
    initFiles({ "staged.txt": "line one\nline two\n" }, "sha256");
    repoGit("add", "staged.txt");
    write("loose.txt", "loose\n");
    const result = await readDiff();
    expect(result.unavailableReason).toBeUndefined();
    const staged = result.files.find((file) => file.path === "staged.txt");
    expect(staged).toMatchObject({ status: "added", additions: 2 });
    expect(staged?.patch).toContain("+line one");
    expect(result.files.find((file) => file.path === "loose.txt")?.untracked).toBe(true);

    expect(filePaths(await useBaseline())).toEqual(["loose.txt", "staged.txt"]);
    expect((await readDiff()).files).toEqual([]);

    append("staged.txt", "later edit\n");
    const changed = await readDiff();
    expect(filePaths(changed)).toEqual(["staged.txt"]);
    expect(changed.files[0]?.patch).toContain("+later edit");
  });

  it.skipIf(process.platform === "win32")(
    "preserves checkout path bytes for detached baseline and diff reads",
    async () => {
      const checkout = path.join(repoRoot, "checkout \n");
      const nested = path.join(checkout, "nested");
      fs.mkdirSync(nested, { recursive: true });
      initRepo(checkout);
      fs.writeFileSync(path.join(checkout, "tracked.txt"), "initial\n");
      git(checkout, "add", "tracked.txt");
      git(checkout, "commit", "-qm", "initial");
      git(checkout, "checkout", "--detach", "-q");
      fs.appendFileSync(path.join(checkout, "tracked.txt"), "changed\n");
      fs.writeFileSync(path.join(checkout, "loose.txt"), "new\n");
      mockSession(nested);

      const captured = await baseline("s1", nested);
      expect(captured?.root).toBe(checkout);
      expect(filePaths(captured)).toEqual(["loose.txt", "tracked.txt"]);
      const result = await readDiff();
      expect(result.root).toBe(checkout);
      expect(result.branch).toBeUndefined();
      expect(filePaths(result)).toEqual(["loose.txt", "tracked.txt"]);

      mockSession(nested, { sessionDiffBaseline: captured });
      expect((await readDiff()).files).toEqual([]);
      fs.appendFileSync(path.join(checkout, "tracked.txt"), "later edit\n");
      const changed = await readDiff();
      expect(filePaths(changed)).toEqual(["tracked.txt"]);
    },
  );

  it("hides unchanged binary files and resurfaces later binary edits", async () => {
    initFiles({ "icon.bin": Buffer.from([0, 1, 2, 0, 3]) });
    const captured = await useBaseline();
    expect(captured?.files).toHaveLength(1);

    const unchanged = await readDiff();
    expect(unchanged.files).toEqual([]);

    write("icon.bin", Buffer.from([0, 1, 9, 0, 3]));
    const changed = await readDiff();
    expect(filePaths(changed)).toEqual(["icon.bin"]);
    expect(changed.files[0]?.binary).toBe(true);
  });

  it("keeps pre-session changes hidden when new files exceed the fingerprint budget", async () => {
    initFiles({ "z-existing.txt": "preexisting work\n" });
    const captured = await baseline();
    expect(filePaths(captured)).toEqual(["z-existing.txt"]);
    const addedPaths = Array.from({ length: 4 }, (_, index) => `a-new-${index}.bin`);
    for (const filePath of addedPaths) {
      write(filePath, Buffer.alloc(4 * 1024 * 1024));
    }
    mockSession(repoRoot, { sessionDiffBaseline: captured });
    const result = await readDiff();
    expect(filePaths(result)).toEqual(addedPaths);
    expect(result.additions).toBe(0);
  });

  it("ignores a baseline from an older session generation", async () => {
    initFiles({ "AGENTS.md": "existing bootstrap\n" });
    await useBaseline("old-session");
    const result = await readDiff();
    expect(filePaths(result)).toEqual(["AGENTS.md"]);
  });

  it.each([false, true])(
    "reads uncommitted changes once when the baseline has no matching paths (prior changes: %s)",
    async (priorChanges) => {
      seedRepo({ "changed.txt": "before\n", "prior.txt": "before\n" });
      if (priorChanges) {
        append("prior.txt", "prior change\n");
      }
      await useBaseline();
      if (priorChanges) {
        commitFiles("save prior change");
      }
      append("changed.txt", "new change\n");

      const commands = vi.spyOn(execRunner, "runCommandBuffersWithTimeout");

      const result = await readDiff({ scope: "uncommitted" });
      expect(result.files).toEqual([
        expect.objectContaining({ path: "changed.txt", additions: 1, deletions: 0 }),
      ]);
      expect(result.files[0]?.patch).toContain("+new change");
      // Revision status, checkout read, base selection, tracked inventory/patch, untracked listing.
      expect(
        commands.mock.calls.filter(([argv]) => argv[argv.indexOf("-C") + 1] === repoRoot).length,
      ).toBeLessThanOrEqual(7);
    },
  );

  it("keeps exact large-file counts and later previews when untracked patches are omitted", async () => {
    initRepo(repoRoot);
    const additions = 140_000;
    write("a-large.txt", `${"x".repeat(127)}\n`.repeat(additions));
    write("b-large.bin", Buffer.alloc(4 * 1024 * 1024 + 1));
    // Each added line's prefix can push a small input beyond the output cap.
    write("c-expanded.txt", "\n".repeat(100_000));
    write("z-small.txt", "small addition\n");
    const result = await readDiff();
    expect(result.files[0]).toEqual(addedFile("a-large.txt", additions, { truncated: true }));
    expect(result.files[1]).toEqual(addedFile("b-large.bin", 0, { binary: true }));
    expect(result.files[2]).toEqual(addedFile("c-expanded.txt", 100_000, { truncated: true }));
    expect(result.files[3]?.patch).toContain("+small addition");
    expect(result).toMatchObject({
      additions: additions + 100_000 + 1,
      deletions: 0,
      truncated: true,
    });
  });

  it.each([false, true])(
    "batches untracked Git reads without changing native output (summary: %s)",
    async (summaryOnly) => {
      seedRepo({ "tracked.txt": "before\n", ".gitignore": "ignored.txt\n" });
      append("tracked.txt", "after\n");
      for (let index = 0; index < 40; index++) {
        write(`loose-${index}.txt`, `line ${index}\nlast line`);
      }
      write("binary.bin", Buffer.from([0, 1, 2]));
      write("empty.txt", "");
      write("large.txt", "large line\n".repeat(20_000));
      write("ignored.txt", "ignored\n");
      if (process.platform !== "win32") {
        fs.symlinkSync("tracked.txt", path.join(repoRoot, "link.txt"));
      }
      const indexBefore = fs.readFileSync(path.join(repoRoot, ".git", "index"));
      const expectedPatches = new Map<string, string>();
      if (!summaryOnly) {
        for (const name of ["loose-0.txt", "empty.txt"]) {
          const native = spawnSync(
            "git",
            ["-c", "core.quotePath=false", "diff", "--no-index", "--", "/dev/null", name],
            { cwd: repoRoot, encoding: "utf8" },
          );
          expect([0, 1]).toContain(native.status);
          expectedPatches.set(name, native.stdout);
        }
      }
      const commands = vi.spyOn(execRunner, "runCommandBuffersWithTimeout");
      const textCommands = vi.spyOn(execRunner, "runCommandWithTimeout");
      const result = await readDiff({ summaryOnly });
      const findFile = (name: string) => result.files.find((file) => file.path === name);
      expect(result.files).toHaveLength(process.platform === "win32" ? 44 : 45);
      expect(findFile("binary.bin")).toEqual(addedFile("binary.bin", 0, { binary: true }));
      expect(findFile("large.txt")).toEqual(
        addedFile("large.txt", 20_000, summaryOnly ? {} : { truncated: true }),
      );
      if (process.platform !== "win32") {
        expect(findFile("link.txt")).toEqual(addedFile("link.txt", 0, { truncated: true }));
      }
      for (const [name, patch] of expectedPatches) {
        expect(result.files.find((file) => file.path === name)?.patch).toBe(patch);
      }
      expect(result.additions).toBe(20_081);
      expect(fs.readFileSync(path.join(repoRoot, ".git", "index"))).toEqual(indexBefore);
      const count = [...commands.mock.calls, ...textCommands.mock.calls].filter(
        ([argv]) => argv[argv.indexOf("-C") + 1] === repoRoot,
      ).length;
      expect(count).toBeLessThanOrEqual(summaryOnly ? 10 : 11);
    },
  );

  it("reads outside sparse cones without writing split-index backing files", async () => {
    fs.mkdirSync(path.join(repoRoot, "kept"));
    seedRepo({ "kept/tracked.txt": "kept\n" });
    repoGit("sparse-checkout", "init", "--cone", "--no-sparse-index");
    repoGit("sparse-checkout", "set", "kept");
    repoGit("config", "core.splitIndex", "true");
    repoGit("config", "splitIndex.maxPercentChange", "0");
    repoGit("config", "splitIndex.sharedIndexExpire", "now");
    repoGit("update-index", "--split-index");
    const objects = path.join(tempDir("openclaw-diff-objects-"), "objects");
    fs.renameSync(path.join(repoRoot, ".git", "objects"), objects);
    fs.mkdirSync(path.join(repoRoot, ".git", "objects"));
    vi.stubEnv("GIT_ALTERNATE_OBJECT_DIRECTORIES", objects);
    fs.mkdirSync(path.join(repoRoot, "outside"), { recursive: true });
    write("outside/loose.txt", "$Id: original $\n");
    const indexFiles = () =>
      fs
        .readdirSync(path.join(repoRoot, ".git"))
        .filter((name) => name === "index" || name.startsWith("sharedindex."))
        .toSorted()
        .map((name) => [name, fs.readFileSync(path.join(repoRoot, ".git", name)).toString("hex")]);
    const before = indexFiles();
    const result = await readDiff();
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ path: "outside/loose.txt", additions: 1 });
    expect(result.files[0]?.patch).toContain("+$Id: original $");
    expect(indexFiles()).toEqual(before);
    expect((await readDiff({ summaryOnly: true })).additions).toBe(1);
    expect(indexFiles()).toEqual(before);
  });

  it("preserves no-index previews when tracked attributes are absent", async () => {
    seedRepo({ ".gitattributes": "*.txt ident\n" });
    fs.unlinkSync(path.join(repoRoot, ".gitattributes"));
    write("loose.txt", "$Id: original $\n");
    const preview = (await readDiff()).files.find((file) => file.path === "loose.txt");
    expect(preview?.patch).toContain("+$Id: original $");
  });

  it.each([false, true])(
    "keeps other untracked files when a required filter fails (summary: %s)",
    async (summaryOnly) => {
      seedRepo({ ".gitattributes": "bad.txt filter=broken\n" });
      repoGit("config", "filter.broken.clean", "false");
      repoGit("config", "filter.broken.required", "true");
      write("bad.txt", "cannot convert\n");
      write("good.txt", "valid addition\n");
      const result = await readDiff({ summaryOnly });
      expect(result.files[0]).toEqual(addedFile("bad.txt", 0, { truncated: true }));
      expect(result.files[1]).toMatchObject(addedFile("good.txt", 1, {}));
      if (!summaryOnly) {
        expect(result.files[1]?.patch).toContain("+valid addition");
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "reuses unchanged diffs and refreshes tracked, untracked, index, and ignore changes",
    async () => {
      vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
      vi.stubEnv("GIT_CONFIG_GLOBAL", os.devNull);
      await drainGlobalSingletonLifecycleState("restart");
      seedRepo({ "tracked.txt": "before\n", ".gitignore": "ignored.txt\n" });
      append("tracked.txt", "after\n");
      write("loose.txt", "new\n");
      write("ignored.txt", "hidden\n");
      const linkedDirectory = tempDir("openclaw-diff-directory-link-");
      fs.mkdirSync(path.join(linkedDirectory, ".git"));
      fs.symlinkSync(linkedDirectory, path.join(repoRoot, "directory-link"));
      const commands = vi.spyOn(execRunner, "runCommandBuffersWithTimeout");
      const full = await readDiff();
      const summary = await readDiff({ summaryOnly: true });
      commands.mockClear();
      expect(await readDiff()).toEqual(full);
      expect(await readDiff({ summaryOnly: true })).toEqual(summary);
      expect(commands.mock.calls.filter(([argv]) => !argv.includes("status"))).toEqual([]);

      write("loose.txt", "new\nsecond\n");
      append("tracked.txt", "third\n");
      expect((await readDiff({ summaryOnly: true })).additions).toBe(4);
      expect((await readDiff()).files.find((file) => file.path === "loose.txt")?.patch).toContain(
        "+second",
      );
      fs.mkdirSync(path.join(repoRoot, "nested", "empty"), { recursive: true });
      await readDiff();
      write("nested/empty/new.txt", "nested addition\n");
      expect(filePaths(await readDiff())).toContain("nested/empty/new.txt");
      repoGit("add", "loose.txt");
      expect(
        (await readDiff()).files.find((file) => file.path === "loose.txt")?.untracked,
      ).toBeUndefined();
      write(".gitignore", "");
      expect(filePaths(await readDiff({ summaryOnly: true }))).toContain("ignored.txt");
      commitFiles("save changes");
      expect((await readDiff({ scope: "uncommitted" })).files).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "invalidates cached diffs when the Git installation's system configuration appears",
    async () => {
      const realGit = resolveExecutablePath("git", { cwd: repoRoot, useCache: false })!;
      const installation = tempDir("openclaw-git-installation-");
      const config = path.join(installation, "system.config");
      const excludes = path.join(installation, "system.ignore");
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      fs.writeFileSync(
        path.join(installation, "git"),
        `#!/bin/sh
if [ "$1" = "-C" ]; then
  cd "$2" || exit 1
  shift 2
fi
if [ "$1" = "var" ] && [ "$2" = "GIT_CONFIG_SYSTEM" ]; then
  printf '%s\\n' ${quote(config)}
else
  GIT_CONFIG_SYSTEM=${quote(config)} exec ${quote(realGit)} "$@"
fi
`,
        { mode: 0o755 },
      );
      vi.stubEnv("GIT_CONFIG_GLOBAL", os.devNull);
      vi.stubEnv("GIT_CONFIG_SYSTEM", undefined);
      vi.stubEnv("GIT_CONFIG_NOSYSTEM", "0");
      vi.stubEnv("PATH", `${installation}${path.delimiter}${process.env.PATH ?? ""}`);
      await drainGlobalSingletonLifecycleState("restart");
      seedRepo({ "tracked.txt": "base\n" });
      write("system-ignored.txt", "new\n");
      expect(filePaths(await readDiff())).toContain("system-ignored.txt");
      const commands = vi.spyOn(execRunner, "runCommandBuffersWithTimeout");
      expect(filePaths(await readDiff())).toContain("system-ignored.txt");
      expect(commands.mock.calls.filter(([argv]) => !argv.includes("status"))).toEqual([]);

      fs.writeFileSync(excludes, "system-ignored.txt\n");
      execFileSync(realGit, ["config", "--file", config, "core.excludesFile", excludes]);
      expect(filePaths(await readDiff())).not.toContain("system-ignored.txt");
    },
  );

  it("keeps tracked and untracked previews under oversized prefixes", async () => {
    const config = `srcPrefix = ${"x".repeat(220_000)}`;

    seedRepo({ "tracked.txt": "before\n" }, "init");
    append(".git/config", `\n[diff]\n ${config}\n`);
    append("tracked.txt", "after\n");
    write("untracked.txt", "new\n");
    const result = await readDiff();
    expect(result.files.map((file) => [file.path, file.additions])).toEqual([
      ["tracked.txt", 1],
      ["untracked.txt", 1],
    ]);
    for (const file of result.files) {
      expect(file.patch).toContain(`+++ b/${file.path}\n`);
      expect(file.truncated).toBeUndefined();
    }
    expect(result.files[0]?.patch).toContain("--- a/tracked.txt\n");
  });

  it("keeps carriage-return header-like content as text in both diff paths", async () => {
    seedRepo({ "tracked.txt": "before\n" }, "init");
    const content =
      "\rBinary files a/x and b/x differ\n\r@@ -0,0 +1,999 @@\n\rdiff --git a/fake b/fake\n\r+++ b/fake\nlast\n";
    append("tracked.txt", content);
    write("untracked.txt", content);
    const result = await readDiff();

    for (const file of result.files) {
      expect(file.additions).toBe(5);
      expect(file.binary).not.toBe(true);
      for (const line of content.split("\n").slice(0, -1)) {
        expect(file.patch).toContain(`+${line}\n`);
      }
    }
    expect(result.additions).toBe(10);
  });

  it.skipIf(process.platform === "win32")(
    "preserves C-escaped and octal filenames in tracked and untracked previews",
    async () => {
      const suffix = '"\\\u0007\b\f\r\v\u0001-café.txt';

      initRepo(repoRoot);
      const trackedPath = `tracked${suffix}`;
      const untrackedPath = `untracked${suffix}`;
      write(trackedPath, "initial\n");
      commitFiles("init");
      append(trackedPath, "later\n");
      write(untrackedPath, "one\ntwo\n");
      const result = await readDiff();
      expect(result.files.map((file) => [file.path, file.additions, file.deletions])).toEqual([
        [trackedPath, 1, 0],
        [untrackedPath, 2, 0],
      ]);
      expect(result.additions).toBe(3);
      expect(result.files[0]?.patch).toContain("+later\n");
      expect(result.files[1]?.patch).toContain("+one\n+two\n");
      expect(result.truncated).toBeUndefined();
    },
  );

  it.each([
    {
      name: "ident contraction",
      attribute: "ident",
      content: Buffer.from(`$Id: ${"x".repeat(150_000)}$\n`),
      normalized: "$Id$\n",
    },
    {
      name: "working-tree encoding",
      attribute: "working-tree-encoding=UTF-16LE",
      content: Buffer.from(`${"A".repeat(60_000)}\n`, "utf16le"),
      normalized: `${"A".repeat(60_000)}\n`,
    },
  ])(
    "keeps fitting untracked previews after $name without extra conversion passes",
    async ({ attribute, content, normalized }) => {
      initRepo(repoRoot);
      write(
        ".git/verbose-filter.mjs",
        'import { appendFileSync } from "node:fs"; appendFileSync(".git/filter-calls", "call\\n"); process.stderr.write("diagnostic\\n".repeat(10_000)); process.stdin.pipe(process.stdout);\n',
      );
      repoGit("config", "filter.verbose.clean", "node .git/verbose-filter.mjs");
      write(".gitattributes", `converted.txt ${attribute} filter=verbose\n`);
      commitFiles("attributes", ".gitattributes");
      write("converted.txt", content);
      const diffArgs = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-index"];
      const native = spawnSync("git", [...diffArgs, "--", "/dev/null", "converted.txt"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      expect(native.status).toBe(1);
      const callsPath = path.join(repoRoot, ".git", "filter-calls");
      const nativeCalls = fs.readFileSync(callsPath, "utf8");
      expect(nativeCalls.length).toBeGreaterThan(0);
      fs.writeFileSync(callsPath, "");
      const result = await readDiff();
      expect(result.files).toHaveLength(1);
      expect(result.files[0]?.additions).toBe(1);
      expect(result.files[0]?.patch?.includes(`+${normalized}`)).toBe(true);
      expect(result.files[0]?.truncated).toBeUndefined();
      expect(fs.readFileSync(callsPath, "utf8")).toBe(nativeCalls);
    },
  );

  it("rejects invalid params through the handler", async () => {
    const invalidParams = [
      {},
      { sessionKey: "agent:main:s1", scope: "commit" },
      { sessionKey: "agent:main:s1", scope: "all", commit: "HEAD" },
      { sessionKey: "agent:main:s1", scope: "uncommitted", commit: "HEAD" },
    ];
    for (const params of invalidParams) {
      const calls = await requestDiff(params, {}, params);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.ok).toBe(false);
    }
  });
});
