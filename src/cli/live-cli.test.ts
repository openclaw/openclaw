import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";

const mocks = vi.hoisted(() => ({
  collectLiveStatus: vi.fn(),
  createDraftWorktree: vi.fn(),
  listLiveJournal: vi.fn(),
  promoteLiveSource: vi.fn(),
  startLiveRuntime: vi.fn(),
}));

const { runtimeLogs, defaultRuntime, resetRuntimeCapture } = createCliRuntimeCapture();

vi.mock("./live-control.js", () => ({
  collectLiveStatus: (...args: unknown[]) => mocks.collectLiveStatus(...args),
  createDraftWorktree: (...args: unknown[]) => mocks.createDraftWorktree(...args),
  listLiveJournal: (...args: unknown[]) => mocks.listLiveJournal(...args),
  promoteLiveSource: (...args: unknown[]) => mocks.promoteLiveSource(...args),
  startLiveRuntime: (...args: unknown[]) => mocks.startLiveRuntime(...args),
}));

vi.mock("./cli-utils.js", () => ({
  runCommandWithRuntime: async (
    _runtime: unknown,
    action: () => Promise<void>,
    onError?: (error: unknown) => void,
  ) => {
    try {
      await action();
    } catch (error) {
      onError?.(error);
    }
  },
}));

vi.mock("../runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../runtime.js")>("../runtime.js")),
  defaultRuntime,
}));

vi.mock("./help-format.js", () => ({
  formatHelpExamples: () => "",
}));

vi.mock("../terminal/links.js", () => ({
  formatDocsLink: () => "docs.openclaw.ai/cli/live",
}));

vi.mock("../terminal/theme.js", () => ({
  colorize: (_rich: boolean, _fn: (value: string) => string, value: string) => value,
  isRich: () => false,
  theme: {
    heading: (value: string) => value,
    muted: (value: string) => value,
    success: (value: string) => value,
    warn: (value: string) => value,
  },
}));

const { registerLiveCli } = await import("./live-cli.js");

describe("live-cli", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerLiveCli(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetRuntimeCapture();
  });

  it("renders live status in text mode", async () => {
    mocks.collectLiveStatus.mockResolvedValueOnce({
      manifest: {
        version: 1,
        createdAt: "2026-04-06T10:00:00.000Z",
        updatedAt: "2026-04-06T10:00:00.000Z",
        liveCheckoutPath: "/tmp/live",
        liveBranch: "main",
        promotedCommit: "abcdef1234567890",
        previousPromotedCommit: null,
        runtimeEntryPath: "/tmp/live/dist/index.js",
        policy: {
          liveMutationsRequirePromote: true,
          branchSwitchesBlocked: true,
          draftStrategy: "worktree",
        },
      },
      liveGit: {
        branch: "main",
        commonDir: "/tmp/live/.git",
        head: "abcdef1234567890",
        root: "/tmp/live",
        dirty: false,
        dirtyLines: [],
      },
      runtime: {
        status: "running",
        summary: "running (pid 99)",
        sourcePath: "/tmp/live",
        matchesLiveCheckout: true,
      },
      watcher: {
        lockPath: "/tmp/live/watch.lock",
        status: "active",
        pid: 99,
        command: "pnpm gateway --force",
        createdAt: "2026-04-06T10:00:00.000Z",
      },
      actorLock: null,
      recentJournal: [
        {
          id: "j1",
          ts: "2026-04-06T10:00:00.000Z",
          actor: "cli:nathan",
          type: "initialized",
          message: "Initialized live control",
          details: {},
        },
      ],
      drafts: [{ path: "/tmp/draft-one", branch: "draft/local", dirty: true }],
      issues: [{ code: "watcher-stale", message: "Watcher needs a restart." }],
    });

    await runCli(["live", "status"]);

    expect(runtimeLogs).toContain("Live Control");
    expect(runtimeLogs).toContain("Live checkout: /tmp/live");
    expect(runtimeLogs).toContain("- Watcher needs a restart.");
    expect(runtimeLogs).toContain("Draft worktrees: 1 (1 dirty)");
    expect(runtimeLogs).toContain("- /tmp/draft-one (draft/local, dirty)");
  });

  it("writes live status JSON when requested", async () => {
    const payload = {
      manifest: { liveCheckoutPath: "/tmp/live" },
      recentJournal: [],
      drafts: [],
      issues: [],
    };
    mocks.collectLiveStatus.mockResolvedValueOnce(payload);

    await runCli(["live", "status", "--json"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(payload);
  });

  it("starts the live runtime with parsed options", async () => {
    mocks.startLiveRuntime.mockResolvedValueOnce({
      manifest: {
        liveCheckoutPath: "/tmp/live",
        promotedCommit: "abcdef1234567890",
      },
    });

    await runCli(["live", "start", "--actor", "codex", "--smoke-timeout", "2500"]);

    expect(mocks.startLiveRuntime).toHaveBeenCalledWith({
      actor: "codex",
      checkout: undefined,
      smokeTimeoutMs: 2500,
    });
    expect(runtimeLogs).toContain("Live runtime restarted from /tmp/live (abcdef1).");
  });

  it("creates a draft worktree and reports the result", async () => {
    mocks.createDraftWorktree.mockResolvedValueOnce({
      branch: "draft/codex-local-20260406-100000",
      manifest: { liveCheckoutPath: "/tmp/live" },
      path: "/tmp/live-control/drafts/openclaw-codex-local-20260406-100000",
    });

    await runCli(["live", "propose", "codex-local", "--message", "Investigate live flow"]);

    expect(mocks.createDraftWorktree).toHaveBeenCalledWith({
      actor: undefined,
      checkout: undefined,
      message: "Investigate live flow",
      name: "codex-local",
    });
    expect(runtimeLogs).toContain(
      "Draft created: /tmp/live-control/drafts/openclaw-codex-local-20260406-100000",
    );
  });

  it("logs a rollback promotion distinctly", async () => {
    mocks.promoteLiveSource.mockResolvedValueOnce({
      manifest: {
        promotedCommit: "fedcba9876543210",
      },
      restoredPreviousLiveState: true,
      sourceRoot: "/tmp/live",
    });

    await runCli(["live", "promote", "rollback", "--actor", "codex"]);

    expect(mocks.promoteLiveSource).toHaveBeenCalledWith({
      actor: "codex",
      buildTimeoutMs: 1_200_000,
      checkout: undefined,
      smokeTimeoutMs: 10_000,
      source: "rollback",
    });
    expect(runtimeLogs).toContain("Live state rolled back to fedcba9.");
  });

  it("prints recent journal entries", async () => {
    mocks.listLiveJournal.mockResolvedValueOnce({
      manifest: { liveCheckoutPath: "/tmp/live" },
      entries: [
        {
          id: "j2",
          ts: "2026-04-06T10:00:00.000Z",
          actor: "codex",
          type: "promoted",
          message: "Promoted draft into live state",
          details: {},
        },
      ],
    });

    await runCli(["live", "journal", "--limit", "5"]);

    expect(mocks.listLiveJournal).toHaveBeenCalledWith({
      checkout: undefined,
      limit: 5,
    });
    expect(runtimeLogs).toContain("Live Journal");
    expect(runtimeLogs).toContain(
      "- 2026-04-06T10:00:00.000Z · codex · promoted · Promoted draft into live state",
    );
  });
});
