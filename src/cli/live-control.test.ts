import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectLiveStatus,
  createDraftWorktree,
  listLiveJournal,
  promoteLiveSource,
  type LiveControlDeps,
} from "./live-control.js";

type GitFixture = {
  branch: string;
  commonDir: string;
  head: string;
  status: string;
};

type GitFixtures = Record<string, GitFixture>;

function createGitRunCommand(fixtures: GitFixtures) {
  return vi.fn(async (argv: string[]) => {
    const [binary, dashC, cwd, ...args] = argv;
    if (binary !== "git" || dashC !== "-C" || typeof cwd !== "string") {
      throw new Error(`Unexpected command: ${argv.join(" ")}`);
    }

    const fixture = fixtures[cwd];
    if (!fixture) {
      return { code: 1, stdout: "", stderr: `unknown git root: ${cwd}` };
    }

    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { code: 0, stdout: `${cwd}\n`, stderr: "" };
    }
    if (args[0] === "branch" && args[1] === "--show-current") {
      return { code: 0, stdout: `${fixture.branch}\n`, stderr: "" };
    }
    if (args[0] === "rev-parse" && args[1] === "HEAD") {
      return { code: 0, stdout: `${fixture.head}\n`, stderr: "" };
    }
    if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
      return { code: 0, stdout: `${fixture.commonDir}\n`, stderr: "" };
    }
    if (
      args[0] === "status" &&
      args[1] === "--porcelain" &&
      args[2] === "--untracked-files=normal"
    ) {
      return { code: 0, stdout: fixture.status, stderr: "" };
    }
    if (args[0] === "worktree" && args[1] === "add") {
      const branch = args[3];
      const draftPath = args[4];
      fixtures[draftPath] = {
        branch,
        commonDir: fixture.commonDir,
        head: fixture.head,
        status: "",
      };
      await fs.mkdir(draftPath, { recursive: true });
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "merge" && args[1] === "--ff-only") {
      fixture.head = args[2] ?? fixture.head;
      fixture.status = "";
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "reset" && args[1] === "--hard") {
      fixture.head = args[2] ?? fixture.head;
      fixture.status = "";
      return { code: 0, stdout: "", stderr: "" };
    }

    throw new Error(`Unhandled git command: ${argv.join(" ")}`);
  });
}

describe("live-control", () => {
  let tempRoot: string;
  let repoDir: string;
  let draftDir: string;
  let stateDir: string;
  let now: Date;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-control-"));
    repoDir = path.join(tempRoot, "openclaw");
    draftDir = path.join(tempRoot, "draft-openclaw");
    stateDir = path.join(tempRoot, "state");
    now = new Date("2026-04-06T10:00:00.000Z");
    await fs.mkdir(repoDir, { recursive: true });
    await fs.mkdir(draftDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  function createDeps(params?: {
    buildCheckout?: LiveControlDeps["buildCheckout"];
    gatherDaemonStatus?: LiveControlDeps["gatherDaemonStatus"];
    git?: GitFixtures;
    restartRuntime?: LiveControlDeps["restartRuntime"];
  }): LiveControlDeps {
    const fixtures = params?.git ?? {
      [repoDir]: {
        branch: "main",
        commonDir: path.join(tempRoot, ".git"),
        head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        status: "",
      },
      [draftDir]: {
        branch: "draft/codex-local",
        commonDir: path.join(tempRoot, ".git"),
        head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        status: "",
      },
    };

    return {
      buildCheckout: params?.buildCheckout ?? vi.fn(async () => {}),
      gatherDaemonStatus:
        params?.gatherDaemonStatus ??
        vi.fn(async () => ({
          service: {
            label: "ai.openclaw.gateway",
            loaded: true,
            loadedText: "loaded",
            notLoadedText: "not loaded",
            command: {
              programArguments: [],
              sourcePath: repoDir,
            },
            runtime: {
              status: "running",
              pid: 4242,
              detail: "healthy",
            },
          },
          rpc: { ok: true },
          extraServices: [],
        })),
      now: () => now,
      resolveStateDir: () => stateDir,
      restartRuntime: params?.restartRuntime ?? vi.fn(async () => {}),
      runCommand: createGitRunCommand(fixtures),
    };
  }

  it("initializes status, records the manifest, and surfaces live-lane drift", async () => {
    const deps = createDeps({
      gatherDaemonStatus: vi.fn(async () => ({
        service: {
          label: "ai.openclaw.gateway",
          loaded: true,
          loadedText: "loaded",
          notLoadedText: "not loaded",
          command: {
            programArguments: [],
            sourcePath: path.join(tempRoot, "other-runtime"),
          },
          runtime: {
            status: "running",
            pid: 999,
            detail: "healthy",
          },
        },
        rpc: { ok: true },
        extraServices: [],
      })),
      git: {
        [repoDir]: {
          branch: "main",
          commonDir: path.join(tempRoot, ".git"),
          head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          status: " M src/cli/live-control.ts\n",
        },
      },
    });

    const status = await collectLiveStatus({
      checkout: repoDir,
      deps,
      actor: "codex",
    });

    expect(status.manifest.liveCheckoutPath).toBe(repoDir);
    expect(status.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "dirty-live-checkout" })]),
    );
    expect(status.watcher.status).toBe("inactive");
    expect(status.issues).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "watcher-inactive" })]),
    );

    const manifestRaw = await fs.readFile(
      path.join(stateDir, "live-control", "manifest.json"),
      "utf8",
    );
    expect(JSON.parse(manifestRaw)).toMatchObject({
      liveCheckoutPath: repoDir,
      liveBranch: "main",
      promotedCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    const journal = await listLiveJournal({ checkout: repoDir, deps, limit: 10 });
    expect(journal.entries[0]).toMatchObject({
      actor: "codex",
      type: "initialized",
    });
  });

  it("prefers the daemon working directory over the service file path for runtime matching", async () => {
    const deps = createDeps({
      gatherDaemonStatus: vi.fn(async () => ({
        service: {
          label: "ai.openclaw.gateway",
          loaded: true,
          loadedText: "loaded",
          notLoadedText: "not loaded",
          command: {
            programArguments: [process.execPath, path.join(repoDir, "dist", "index.js")],
            sourcePath: "/Users/nathan/Library/LaunchAgents/ai.openclaw.gateway.plist",
            workingDirectory: repoDir,
          },
          runtime: {
            status: "running",
            pid: 4242,
            detail: "healthy",
          },
        },
        rpc: { ok: true },
        extraServices: [],
      })),
    });

    const status = await collectLiveStatus({
      checkout: repoDir,
      deps,
      actor: "codex",
    });

    expect(status.runtime.sourcePath).toBe(repoDir);
    expect(status.runtime.matchesLiveCheckout).toBe(true);
    expect(status.issues).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "runtime-source-mismatch" })]),
    );
  });

  it("creates a dedicated draft worktree and journals it", async () => {
    const deps = createDeps();

    const result = await createDraftWorktree({
      actor: "codex",
      checkout: repoDir,
      deps,
      message: "Parallel feature work",
      name: "codex-local",
    });

    expect(result.branch).toMatch(/^draft\/codex-local-/);
    expect(result.path).toContain(path.join(stateDir, "live-control", "drafts"));

    const journal = await listLiveJournal({ checkout: repoDir, deps, limit: 10 });
    expect(journal.entries[0]).toMatchObject({
      actor: "codex",
      type: "draft_created",
    });
    expect(journal.entries[0]?.details).toMatchObject({
      note: "Parallel feature work",
    });
  });

  it("surfaces dirty draft worktrees without treating inactive watch mode as an issue", async () => {
    const git = {
      [repoDir]: {
        branch: "main",
        commonDir: path.join(tempRoot, ".git"),
        head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        status: "",
      },
    };
    const deps = createDeps({ git });

    const result = await createDraftWorktree({
      actor: "codex",
      checkout: repoDir,
      deps,
      name: "codex-local",
    });
    git[result.path].status = " M src/cli/live-control.ts\n";

    const status = await collectLiveStatus({
      checkout: repoDir,
      deps,
      actor: "codex",
    });

    expect(status.watcher.status).toBe("inactive");
    expect(status.issues).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "watcher-inactive" })]),
    );
    expect(status.drafts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: result.path,
          branch: result.branch,
          dirty: true,
        }),
      ]),
    );
  });

  it("rolls back to the previous promoted commit and records the change", async () => {
    const deps = createDeps();
    await collectLiveStatus({ checkout: repoDir, deps, actor: "codex" });

    const manifestPath = path.join(stateDir, "live-control", "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      previousPromotedCommit: string | null;
    };
    manifest.previousPromotedCommit = "cccccccccccccccccccccccccccccccccccccccc";
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const result = await promoteLiveSource({
      actor: "codex",
      checkout: repoDir,
      deps,
      source: "rollback",
    });

    expect(result.restoredPreviousLiveState).toBe(true);
    expect(result.manifest.promotedCommit).toBe("cccccccccccccccccccccccccccccccccccccccc");

    const journal = await listLiveJournal({ checkout: repoDir, deps, limit: 10 });
    expect(journal.entries[0]).toMatchObject({
      actor: "codex",
      type: "rolled_back",
    });
  });

  it("restores the previous live state when a promotion fails after merge", async () => {
    const buildCheckout = vi
      .fn<LiveControlDeps["buildCheckout"]>()
      .mockRejectedValueOnce(new Error("build exploded"))
      .mockResolvedValueOnce(undefined);
    const restartRuntime = vi.fn<LiveControlDeps["restartRuntime"]>().mockResolvedValue(undefined);
    const git = {
      [repoDir]: {
        branch: "main",
        commonDir: path.join(tempRoot, ".git"),
        head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        status: "",
      },
      [draftDir]: {
        branch: "draft/codex-local",
        commonDir: path.join(tempRoot, ".git"),
        head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        status: "",
      },
    };
    const deps = createDeps({ buildCheckout, git, restartRuntime });

    await collectLiveStatus({ checkout: repoDir, deps, actor: "codex" });

    await expect(
      promoteLiveSource({
        actor: "codex",
        checkout: repoDir,
        cwd: draftDir,
        deps,
        source: draftDir,
      }),
    ).rejects.toThrow("build exploded");

    expect(buildCheckout).toHaveBeenCalledTimes(2);
    expect(restartRuntime).toHaveBeenCalledTimes(1);

    const manifest = JSON.parse(
      await fs.readFile(path.join(stateDir, "live-control", "manifest.json"), "utf8"),
    ) as { promotedCommit: string };
    expect(manifest.promotedCommit).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    const journal = await listLiveJournal({ checkout: repoDir, deps, limit: 10 });
    expect(journal.entries[0]).toMatchObject({
      actor: "codex",
      type: "promotion_failed",
    });
  });
});
