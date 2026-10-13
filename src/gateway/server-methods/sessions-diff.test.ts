// Session diff RPC tests run against real throwaway git repos so the parsing
// stays honest about git's -z output and --no-index untracked handling.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import * as execRunner from "../../process/exec-runner.js";
import { captureSessionDiffBaseline } from "../../sessions/session-diff.js";
import { loadSessionDiff, sessionsDiffHandlers } from "./sessions-diff.js";

const hoisted = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  patchSessionEntryCore: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
}));

vi.mock("../session-utils.js", () => ({
  loadSessionEntry: hoisted.loadSessionEntry,
  loadGatewaySessionEntryReadOnly: hoisted.loadSessionEntry,
}));

// mock-isolation: Diff RPC cases supply session discovery while exercising real Git reads.
vi.mock("../session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: (params: { key: string; agentId?: string }) =>
    hoisted.loadSessionEntry(params.key, { agentId: params.agentId }),
}));

vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  resolveAgentWorkspaceDir: hoisted.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: hoisted.resolveDefaultAgentId,
}));

// mock-isolation: Diff RPC cases control session persistence independently of throwaway Git repos.
vi.mock("../../config/sessions/session-accessor.js", () => ({
  patchSessionEntryCore: hoisted.patchSessionEntryCore,
}));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function initRepo(root: string, objectFormat?: "sha1" | "sha256"): void {
  git(
    root,
    "init",
    "-q",
    "-b",
    "main",
    ...(objectFormat ? [`--object-format=${objectFormat}`] : []),
  );
  git(root, "config", "user.email", "test@openclaw.test");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");
}

function mockSession(spawnedCwd: string, entry: Record<string, unknown> = {}): void {
  hoisted.loadSessionEntry.mockReturnValue({
    agentId: "main",
    cfg: {},
    entry: { sessionId: "s1", spawnedCwd, ...entry },
    storePath: "/tmp/sessions.json",
    canonicalKey: "agent:main:s1",
  });
}

describe("loadSessionDiff", () => {
  let repoRoot: string;

  beforeEach(() => {
    setRuntimeConfigSnapshot({});
    vi.clearAllMocks();
    repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sessions-diff-")));
    hoisted.resolveDefaultAgentId.mockReturnValue("main");
    hoisted.resolveAgentWorkspaceDir.mockReturnValue(repoRoot);
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    clearRuntimeConfigSnapshot();
  });

  it("reports unknown sessions without touching a workspace", async () => {
    hoisted.loadSessionEntry.mockReturnValue({
      agentId: "main",
      cfg: {},
      entry: undefined,
      storePath: undefined,
      canonicalKey: "agent:main:missing",
    });
    const result = await loadSessionDiff({ sessionKey: "agent:main:missing" });
    expect(result.unavailableReason).toBe("unknown_session");
    expect(result.files).toEqual([]);
  });

  it.each([{ pendingProjectGitUrl: "https://github.com/example/project.git" }])(
    "keeps pending checkouts separate from the agent workspace: %j",
    async (pending) => {
      initRepo(repoRoot);
      fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "Agent workspace bootstrap\n");
      mockSession(repoRoot, { spawnedCwd: undefined, ...pending });

      expect(await loadSessionDiff({ sessionKey: "agent:main:s1" })).toEqual({
        sessionKey: "agent:main:s1",
        files: [],
        additions: 0,
        deletions: 0,
      });
    },
  );

  // Diff and baseline reads run inside the Gateway process against user
  // checkouts, so a checkout-configured core.fsmonitor command (or hook) must
  // never execute — same invariant as the publication git transport.
  it.skipIf(process.platform === "win32")(
    "never executes a checkout-configured core.fsmonitor command",
    async () => {
      initRepo(repoRoot);
      fs.writeFileSync(path.join(repoRoot, "a.txt"), "one\n");
      git(repoRoot, "add", "a.txt");
      git(repoRoot, "commit", "-qm", "init");
      fs.writeFileSync(path.join(repoRoot, "a.txt"), "two\n");
      // Script and sentinel live outside the checkout so they never show up
      // as untracked entries in the diffs under test.
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-fsmonitor-"));
      try {
        const sentinel = path.join(outside, "sentinel");
        const hook = path.join(outside, "fsmonitor.sh");
        fs.writeFileSync(hook, `#!/bin/sh\n: > "${sentinel}"\nexit 1\n`, { mode: 0o755 });
        git(repoRoot, "config", "core.fsmonitor", hook);
        // Sanity: unpinned git in this checkout does run the command.
        git(repoRoot, "status", "--porcelain");
        expect(fs.existsSync(sentinel)).toBe(true);
        fs.rmSync(sentinel);

        mockSession(repoRoot);
        const diff = await loadSessionDiff({ sessionKey: "agent:main:s1" });
        expect(diff.files.map((file) => file.path)).toEqual(["a.txt"]);
        const baseline = await captureSessionDiffBaseline({ cwd: repoRoot, sessionId: "s1" });
        expect(baseline?.files.map((file) => file.path)).toEqual(["a.txt"]);
        expect(fs.existsSync(sentinel)).toBe(false);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it("uses the persisted fixed-store owner for a bare session checkout", async () => {
    initRepo(repoRoot);
    fs.writeFileSync(path.join(repoRoot, "owned.txt"), "ops\n");
    const cfg = {
      session: { store: "/tmp/shared.sqlite", scope: "global" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    } as const;
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
    const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];

    await sessionsDiffHandlers["sessions.diff"]?.({
      req: { type: "req", id: "sessions.diff", method: "sessions.diff", params: {} },
      params: { sessionKey: "global" },
      client: null,
      isWebchatConnect: () => false,
      respond: (ok, payload, error) => calls.push({ ok, payload, error }),
      context: {
        getRuntimeConfig: () => cfg,
        logGateway: createSubsystemLogger("test/sessions-diff"),
      } as never,
    });

    expect(calls).toEqual([
      expect.objectContaining({
        ok: true,
        payload: expect.objectContaining({ root: repoRoot }),
      }),
    ]);
    expect(hoisted.loadSessionEntry).toHaveBeenCalledWith(
      "global",
      expect.objectContaining({ agentId: "ops" }),
    );
    expect(hoisted.resolveAgentWorkspaceDir).toHaveBeenCalledWith(cfg, "ops");
  });

  it("rejects a foreign agent before loading a bare fixed-store checkout", async () => {
    const cfg = {
      session: { store: "/tmp/shared.sqlite", scope: "global" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    } as const;
    setRuntimeConfigSnapshot(cfg);
    const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];

    await sessionsDiffHandlers["sessions.diff"]?.({
      req: { type: "req", id: "sessions.diff", method: "sessions.diff", params: {} },
      params: { sessionKey: "global", agentId: "research" },
      client: null,
      isWebchatConnect: () => false,
      respond: (ok, payload, error) => calls.push({ ok, payload, error }),
      context: { getRuntimeConfig: () => cfg } as never,
    });

    expect(calls).toEqual([
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "INVALID_REQUEST",
          message: 'agent "research" does not match session key agent "ops"',
        }),
      }),
    ]);
    expect(hoisted.loadSessionEntry).not.toHaveBeenCalled();
  });

  it("keeps tracked counts while omitting patches above the total changed-line limit", async () => {
    initRepo(repoRoot);
    fs.writeFileSync(path.join(repoRoot, "large.txt"), "before\n");
    fs.writeFileSync(path.join(repoRoot, "small.txt"), "before\n");
    git(repoRoot, "add", ".");
    git(repoRoot, "commit", "-qm", "init");
    fs.writeFileSync(path.join(repoRoot, "large.txt"), "after\n".repeat(100_001));
    fs.writeFileSync(path.join(repoRoot, "small.txt"), "after\n");
    mockSession(repoRoot);

    const runCommand = execRunner.runCommandBuffersWithTimeout;
    let trackedDiffCommands = 0;
    const observer = vi
      .spyOn(execRunner, "runCommandBuffersWithTimeout")
      .mockImplementation((argv, options) => {
        if (
          argv[argv.indexOf("-C") + 1] === repoRoot &&
          argv.includes("diff") &&
          !argv.includes("--no-index")
        ) {
          trackedDiffCommands++;
        }
        return runCommand(argv, options);
      });
    try {
      const result = await loadSessionDiff({ sessionKey: "agent:main:s1" });

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
      expect(result.additions).toBe(100_002);
      expect(result.deletions).toBe(2);
      expect(trackedDiffCommands).toBeLessThanOrEqual(1);
    } finally {
      observer.mockRestore();
    }
  });

  it("reports a failed tracked inventory instead of an empty diff", async () => {
    initRepo(repoRoot);
    fs.writeFileSync(path.join(repoRoot, "tracked.txt"), "before\n");
    git(repoRoot, "add", ".");
    git(repoRoot, "commit", "-qm", "init");
    fs.writeFileSync(path.join(repoRoot, "tracked.txt"), "after\n");
    mockSession(repoRoot);
    const runCommand = execRunner.runCommandBuffersWithTimeout;
    const observer = vi
      .spyOn(execRunner, "runCommandBuffersWithTimeout")
      .mockImplementation(async (argv, options) => {
        const result = await runCommand(argv, options);
        return argv[argv.indexOf("-C") + 1] === repoRoot && argv.includes("--numstat")
          ? { ...result, code: 1, stdout: Buffer.alloc(0) }
          : result;
      });
    try {
      await expect(loadSessionDiff({ sessionKey: "agent:main:s1" })).rejects.toThrow(
        "Unable to read tracked Git changes",
      );
    } finally {
      observer.mockRestore();
    }
  });

  it.each(["sha256"] as const)(
    "shows an unrelated root commit merged into the feature branch in a %s repository",
    async (objectFormat) => {
      initRepo(repoRoot, objectFormat);
      fs.writeFileSync(path.join(repoRoot, "base.txt"), "base\n");
      git(repoRoot, "add", ".");
      git(repoRoot, "commit", "-qm", "base");
      git(repoRoot, "checkout", "--orphan", "imported", "-q");
      git(repoRoot, "rm", "-rf", ".");
      fs.writeFileSync(path.join(repoRoot, "imported.txt"), "imported root\n");
      git(repoRoot, "add", ".");
      git(repoRoot, "commit", "-qm", "imported root");
      const rootCommit = git(repoRoot, "rev-parse", "HEAD").trim();
      git(repoRoot, "checkout", "-qb", "feature", "main");
      git(repoRoot, "merge", "--allow-unrelated-histories", "--no-edit", "imported");
      fs.appendFileSync(path.join(repoRoot, "imported.txt"), "working tree edit\n");
      mockSession(repoRoot);

      const result = await loadSessionDiff({
        sessionKey: "agent:main:s1",
        scope: "commit",
        commit: rootCommit,
      });

      expect(result.unavailableReason).toBeUndefined();
      expect(result.files.map((file) => file.path)).toEqual(["imported.txt"]);
      expect(result.files[0]).toMatchObject({ status: "added", additions: 1, deletions: 0 });
      expect(result.files[0]?.patch).toContain("+imported root");
      expect(result.files[0]?.patch).not.toContain("working tree edit");
    },
  );

  it.each(["origin/master"])(
    "scopes branch, working-tree, and commit diffs against %s with branch metadata",
    async (baseRef) => {
      initRepo(repoRoot);
      fs.writeFileSync(path.join(repoRoot, "base.txt"), "base\n");
      git(repoRoot, "add", ".");
      git(repoRoot, "commit", "-qm", "base");
      const mergeBase = git(repoRoot, "rev-parse", "HEAD").trim();
      git(repoRoot, "checkout", "-qb", "sibling");
      fs.writeFileSync(path.join(repoRoot, "sibling.txt"), "sibling commit\n");
      git(repoRoot, "add", ".");
      git(repoRoot, "commit", "-qm", "sibling change");
      const siblingCommit = git(repoRoot, "rev-parse", "HEAD").trim();
      git(repoRoot, "checkout", "-q", "main");
      git(repoRoot, "checkout", "-qb", "feature");
      if (baseRef !== "main") {
        git(repoRoot, "update-ref", `refs/remotes/${baseRef}`, mergeBase);
        git(repoRoot, "branch", "-d", "main");
      }

      fs.writeFileSync(path.join(repoRoot, "first.txt"), "first commit\n");
      git(repoRoot, "add", ".");
      git(repoRoot, "commit", "-qm", "first change");
      const firstCommit = git(repoRoot, "rev-parse", "HEAD").trim();
      fs.writeFileSync(path.join(repoRoot, "second.txt"), "second commit\n");
      git(repoRoot, "add", ".");
      git(repoRoot, "commit", "-qm", "second change");
      const secondCommit = git(repoRoot, "rev-parse", "HEAD").trim();

      fs.appendFileSync(path.join(repoRoot, "second.txt"), "working tree\n");
      fs.writeFileSync(path.join(repoRoot, "loose.txt"), "untracked\n");
      mockSession(repoRoot);

      const all = await loadSessionDiff({ sessionKey: "agent:main:s1" });
      expect(all.baseRef).toBe(baseRef);
      expect(all.files.map((file) => file.path)).toEqual(["first.txt", "loose.txt", "second.txt"]);
      expect(all.aheadCount).toBe(2);
      expect(all.commits).toEqual([
        {
          sha: git(repoRoot, "rev-parse", "--short", secondCommit).trim(),
          subject: "second change",
        },
        { sha: git(repoRoot, "rev-parse", "--short", firstCommit).trim(), subject: "first change" },
      ]);
      expect(all.mergeBase).toEqual({
        sha: git(repoRoot, "rev-parse", "--short", mergeBase).trim(),
        subject: "base",
      });

      const uncommitted = await loadSessionDiff({
        sessionKey: "agent:main:s1",
        scope: "uncommitted",
      });
      expect(uncommitted.files.map((file) => file.path)).toEqual(["loose.txt", "second.txt"]);
      expect(uncommitted.files.find((file) => file.path === "second.txt")?.patch).toContain(
        "+working tree",
      );

      const baseline = await captureSessionDiffBaseline({ cwd: repoRoot, sessionId: "s1" });
      mockSession(repoRoot, { sessionDiffBaseline: baseline });
      const committed = await loadSessionDiff({
        sessionKey: "agent:main:s1",
        scope: "commit",
        commit: firstCommit,
      });
      expect(committed.files.map((file) => file.path)).toEqual(["first.txt"]);
      expect(committed.files[0]?.patch).toContain("+first commit");
      expect(committed.files[0]?.untracked).toBeUndefined();

      for (const commit of [siblingCommit, mergeBase]) {
        const outsideAdvertisedHistory = await loadSessionDiff({
          sessionKey: "agent:main:s1",
          scope: "commit",
          commit,
        });
        expect(outsideAdvertisedHistory.unavailableReason).toBe("unknown_commit");
        expect(outsideAdvertisedHistory.files).toEqual([]);
      }

      const unknown = await loadSessionDiff({
        sessionKey: "agent:main:s1",
        scope: "commit",
        commit: "not-a-commit",
      });
      expect(unknown.unavailableReason).toBe("unknown_commit");
      expect(unknown.files).toEqual([]);
    },
  );

  it("never executes configured textconv drivers from the read RPC", async () => {
    initRepo(repoRoot);
    fs.writeFileSync(path.join(repoRoot, ".gitattributes"), "*.txt diff=evil\n");
    fs.writeFileSync(path.join(repoRoot, "a.txt"), "one\n");
    git(repoRoot, "add", ".");
    git(repoRoot, "commit", "-qm", "init");
    const marker = path.join(repoRoot, "pwned");
    git(repoRoot, "config", "diff.evil.textconv", `touch ${marker}; cat`);
    fs.writeFileSync(path.join(repoRoot, "a.txt"), "one\ntwo\n");
    fs.writeFileSync(path.join(repoRoot, "untracked.txt"), "new\n");
    mockSession(repoRoot);

    const result = await loadSessionDiff({ sessionKey: "agent:main:s1" });

    expect(fs.existsSync(marker)).toBe(false);
    const tracked = result.files.find((file) => file.path === "a.txt");
    expect(tracked?.patch).toContain("+two");
  });

  it("withholds patch content for hardlinked files pointing outside the checkout", async () => {
    const secretDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-secret-")));
    const secretFile = path.join(secretDir, "secret.txt");
    fs.writeFileSync(secretFile, "TOP SECRET VALUE\n");
    try {
      initRepo(repoRoot);
      fs.writeFileSync(path.join(repoRoot, "seed.txt"), "seed\n");
      git(repoRoot, "add", ".");
      git(repoRoot, "commit", "-qm", "init");
      // Untracked hardlink to an out-of-tree secret: same inode, in-tree name.
      fs.linkSync(secretFile, path.join(repoRoot, "leak.txt"));
      // Tracked file replaced by a hardlink to the same secret after commit.
      fs.writeFileSync(path.join(repoRoot, "tracked.txt"), "original\n");
      git(repoRoot, "add", "tracked.txt");
      git(repoRoot, "commit", "-qm", "add tracked");
      fs.rmSync(path.join(repoRoot, "tracked.txt"));
      fs.linkSync(secretFile, path.join(repoRoot, "tracked.txt"));
      mockSession(repoRoot);

      const result = await loadSessionDiff({ sessionKey: "agent:main:s1" });

      expect(JSON.stringify(result)).not.toContain("TOP SECRET VALUE");
      for (const name of ["leak.txt", "tracked.txt"]) {
        const file = result.files.find((entry) => entry.path === name);
        expect(file?.patch).toBeUndefined();
        expect(file?.truncated).toBe(true);
      }
    } finally {
      fs.rmSync(secretDir, { recursive: true, force: true });
    }
  });

  it.each(["sha256"] as const)(
    "reports staged files and filters the session baseline before the first %s commit",
    async (objectFormat) => {
      initRepo(repoRoot, objectFormat);
      fs.writeFileSync(path.join(repoRoot, "staged.txt"), "line one\nline two\n");
      git(repoRoot, "add", "staged.txt");
      fs.writeFileSync(path.join(repoRoot, "loose.txt"), "loose\n");
      mockSession(repoRoot);

      const result = await loadSessionDiff({ sessionKey: "agent:main:s1" });

      expect(result.unavailableReason).toBeUndefined();
      const staged = result.files.find((file) => file.path === "staged.txt");
      expect(staged?.status).toBe("added");
      expect(staged?.additions).toBe(2);
      expect(staged?.patch).toContain("+line one");
      // The untracked scan still covers files git does not track yet.
      expect(result.files.find((file) => file.path === "loose.txt")?.untracked).toBe(true);

      const baseline = await captureSessionDiffBaseline({ cwd: repoRoot, sessionId: "s1" });
      expect(baseline?.files.map((file) => file.path)).toEqual(["loose.txt", "staged.txt"]);
      mockSession(repoRoot, { sessionDiffBaseline: baseline });
      expect((await loadSessionDiff({ sessionKey: "agent:main:s1" })).files).toEqual([]);

      fs.appendFileSync(path.join(repoRoot, "staged.txt"), "later edit\n");
      const changed = await loadSessionDiff({ sessionKey: "agent:main:s1" });
      expect(changed.files.map((file) => file.path)).toEqual(["staged.txt"]);
      expect(changed.files[0]?.patch).toContain("+later edit");
    },
  );

  it.skipIf(process.platform === "win32").each(["detached"])(
    "preserves checkout path bytes for %s baseline and diff reads",
    async (revision) => {
      const checkout = path.join(repoRoot, "checkout \n");
      const nested = path.join(checkout, "nested");
      fs.mkdirSync(nested, { recursive: true });
      initRepo(checkout);
      fs.writeFileSync(path.join(checkout, "tracked.txt"), "initial\n");
      git(checkout, "add", "tracked.txt");
      if (revision !== "unborn") {
        git(checkout, "commit", "-qm", "initial");
        if (revision === "detached") {
          git(checkout, "checkout", "--detach", "-q");
        }
      }
      fs.appendFileSync(path.join(checkout, "tracked.txt"), "changed\n");
      fs.writeFileSync(path.join(checkout, "loose.txt"), "new\n");
      mockSession(nested);

      const baseline = await captureSessionDiffBaseline({ cwd: nested, sessionId: "s1" });
      expect(baseline?.root).toBe(checkout);
      expect(baseline?.files.map((file) => file.path)).toEqual(["loose.txt", "tracked.txt"]);
      const result = await loadSessionDiff({ sessionKey: "agent:main:s1" });
      expect(result.root).toBe(checkout);
      expect(result.branch).toBe(revision === "branch" ? "main" : undefined);
      expect(result.files.map((file) => file.path)).toEqual(["loose.txt", "tracked.txt"]);

      mockSession(nested, { sessionDiffBaseline: baseline });
      expect((await loadSessionDiff({ sessionKey: "agent:main:s1" })).files).toEqual([]);
      fs.appendFileSync(path.join(checkout, "tracked.txt"), "later edit\n");
      const changed = await loadSessionDiff({ sessionKey: "agent:main:s1" });
      expect(changed.files.map((file) => file.path)).toEqual(["tracked.txt"]);
    },
  );

  it("hides unchanged binary files and resurfaces later binary edits", async () => {
    initRepo(repoRoot);
    fs.writeFileSync(path.join(repoRoot, "icon.bin"), Buffer.from([0, 1, 2, 0, 3]));
    mockSession(repoRoot);

    const baseline = await captureSessionDiffBaseline({
      cwd: repoRoot,
      sessionId: "s1",
    });
    expect(baseline?.files).toHaveLength(1);

    mockSession(repoRoot, { sessionDiffBaseline: baseline });
    const unchanged = await loadSessionDiff({ sessionKey: "agent:main:s1" });
    expect(unchanged.files).toEqual([]);

    fs.writeFileSync(path.join(repoRoot, "icon.bin"), Buffer.from([0, 1, 9, 0, 3]));
    const changed = await loadSessionDiff({ sessionKey: "agent:main:s1" });
    expect(changed.files.map((file) => file.path)).toEqual(["icon.bin"]);
    expect(changed.files[0]?.binary).toBe(true);
  });

  it("keeps pre-session changes hidden when new files exceed the fingerprint budget", async () => {
    initRepo(repoRoot);
    fs.writeFileSync(path.join(repoRoot, "z-existing.txt"), "preexisting work\n");
    const baseline = await captureSessionDiffBaseline({ cwd: repoRoot, sessionId: "s1" });
    expect(baseline?.files.map((file) => file.path)).toEqual(["z-existing.txt"]);
    const addedPaths = Array.from({ length: 4 }, (_, index) => `a-new-${index}.bin`);
    for (const filePath of addedPaths) {
      fs.writeFileSync(path.join(repoRoot, filePath), Buffer.alloc(4 * 1024 * 1024));
    }
    mockSession(repoRoot, { sessionDiffBaseline: baseline });

    const result = await loadSessionDiff({ sessionKey: "agent:main:s1" });

    expect(result.files.map((file) => file.path)).toEqual(addedPaths);
    expect(result.additions).toBe(0);
  });

  it("ignores a baseline from an older session generation", async () => {
    initRepo(repoRoot);
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "existing bootstrap\n");
    mockSession(repoRoot);
    const baseline = await captureSessionDiffBaseline({
      cwd: repoRoot,
      sessionId: "old-session",
    });

    mockSession(repoRoot, { sessionDiffBaseline: baseline });
    const result = await loadSessionDiff({ sessionKey: "agent:main:s1" });

    expect(result.files.map((file) => file.path)).toEqual(["AGENTS.md"]);
  });

  it("keeps exact large-file counts and later previews when untracked patches are omitted", async () => {
    initRepo(repoRoot);
    const additions = 140_000;
    fs.writeFileSync(path.join(repoRoot, "a-large.txt"), `${"x".repeat(127)}\n`.repeat(additions));
    fs.writeFileSync(path.join(repoRoot, "b-large.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
    // Each added line's prefix can push a small input beyond the output cap.
    fs.writeFileSync(path.join(repoRoot, "c-expanded.txt"), "\n".repeat(100_000));
    fs.writeFileSync(path.join(repoRoot, "z-small.txt"), "small addition\n");
    mockSession(repoRoot);

    const result = await loadSessionDiff({ sessionKey: "agent:main:s1" });

    expect(result.files[0]).toEqual({
      path: "a-large.txt",
      status: "added",
      additions,
      deletions: 0,
      untracked: true,
      truncated: true,
    });
    expect(result.files[1]).toEqual({
      path: "b-large.bin",
      status: "added",
      additions: 0,
      deletions: 0,
      untracked: true,
      binary: true,
    });
    expect(result.files[2]).toEqual({
      path: "c-expanded.txt",
      status: "added",
      additions: 100_000,
      deletions: 0,
      untracked: true,
      truncated: true,
    });
    expect(result.files[3]?.patch).toContain("+small addition");
    expect(result.additions).toBe(additions + 100_000 + 1);
    expect(result.deletions).toBe(0);
    expect(result.truncated).toBe(true);
  });

  it.each([{ name: "oversized prefixes", config: `srcPrefix = ${"x".repeat(220_000)}` }])(
    "keeps tracked and untracked previews under $name",
    async ({ config }) => {
      initRepo(repoRoot);
      fs.writeFileSync(path.join(repoRoot, "tracked.txt"), "before\n");
      git(repoRoot, "add", ".");
      git(repoRoot, "commit", "-qm", "init");
      fs.appendFileSync(path.join(repoRoot, ".git", "config"), `\n[diff]\n ${config}\n`);
      fs.appendFileSync(path.join(repoRoot, "tracked.txt"), "after\n");
      fs.writeFileSync(path.join(repoRoot, "untracked.txt"), "new\n");
      mockSession(repoRoot);

      const result = await loadSessionDiff({ sessionKey: "agent:main:s1" });

      expect(result.files.map((file) => [file.path, file.additions])).toEqual([
        ["tracked.txt", 1],
        ["untracked.txt", 1],
      ]);
      for (const file of result.files) {
        expect(file.patch).toContain(`+++ b/${file.path}\n`);
        expect(file.truncated).toBeUndefined();
      }
      expect(result.files[0]?.patch).toContain("--- a/tracked.txt\n");
    },
  );

  it("keeps carriage-return header-like content as text in both diff paths", async () => {
    initRepo(repoRoot);
    fs.writeFileSync(path.join(repoRoot, "tracked.txt"), "before\n");
    git(repoRoot, "add", ".");
    git(repoRoot, "commit", "-qm", "init");
    const content =
      "\rBinary files a/x and b/x differ\n\r@@ -0,0 +1,999 @@\n\rdiff --git a/fake b/fake\n\r+++ b/fake\nlast\n";
    fs.appendFileSync(path.join(repoRoot, "tracked.txt"), content);
    fs.writeFileSync(path.join(repoRoot, "untracked.txt"), content);
    mockSession(repoRoot);

    const result = await loadSessionDiff({ sessionKey: "agent:main:s1" });

    for (const file of result.files) {
      expect(file.additions).toBe(5);
      expect(file.binary).not.toBe(true);
      for (const line of content.split("\n").slice(0, -1)) {
        expect(file.patch).toContain(`+${line}\n`);
      }
    }
    expect(result.additions).toBe(10);
  });

  it
    .skipIf(process.platform === "win32")
    .each([{ name: "C-escaped and octal", suffix: '"\\\u0007\b\f\r\v\u0001-café.txt' }])(
    "preserves $name filenames in tracked and untracked previews",
    async ({ suffix }) => {
      initRepo(repoRoot);
      const trackedPath = `tracked${suffix}`;
      const untrackedPath = `untracked${suffix}`;
      fs.writeFileSync(path.join(repoRoot, trackedPath), "initial\n");
      git(repoRoot, "add", ".");
      git(repoRoot, "commit", "-qm", "init");
      fs.appendFileSync(path.join(repoRoot, trackedPath), "later\n");
      fs.writeFileSync(path.join(repoRoot, untrackedPath), "one\ntwo\n");
      mockSession(repoRoot);

      const result = await loadSessionDiff({ sessionKey: "agent:main:s1" });

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
      fs.writeFileSync(
        path.join(repoRoot, ".git", "verbose-filter.mjs"),
        'import { appendFileSync } from "node:fs"; appendFileSync(".git/filter-calls", "call\\n"); process.stderr.write("diagnostic\\n".repeat(10_000)); process.stdin.pipe(process.stdout);\n',
      );
      git(repoRoot, "config", "filter.verbose.clean", "node .git/verbose-filter.mjs");
      fs.writeFileSync(
        path.join(repoRoot, ".gitattributes"),
        `converted.txt ${attribute} filter=verbose\n`,
      );
      git(repoRoot, "add", ".gitattributes");
      git(repoRoot, "commit", "-qm", "attributes");
      fs.writeFileSync(path.join(repoRoot, "converted.txt"), content);
      const native = spawnSync(
        "git",
        [
          "-C",
          repoRoot,
          "diff",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--no-index",
          "--",
          "/dev/null",
          "converted.txt",
        ],
        { encoding: "utf8" },
      );
      expect(native.status).toBe(1);
      const callsPath = path.join(repoRoot, ".git", "filter-calls");
      const nativeCalls = fs.readFileSync(callsPath, "utf8");
      expect(nativeCalls.length).toBeGreaterThan(0);
      fs.writeFileSync(callsPath, "");
      mockSession(repoRoot);

      const result = await loadSessionDiff({ sessionKey: "agent:main:s1" });

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
      const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
      await sessionsDiffHandlers["sessions.diff"]?.({
        req: { type: "req", id: "sessions.diff", method: "sessions.diff", params },
        params,
        client: null,
        isWebchatConnect: () => false,
        respond: (ok: boolean, payload?: unknown, error?: unknown) => {
          calls.push({ ok, payload, error });
        },
        context: { getRuntimeConfig: () => ({}) } as never,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.ok).toBe(false);
    }
  });
});
