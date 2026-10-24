import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./agent-command.test-mocks.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { prepareAgentCommandExecution } from "../agents/command/prepare.js";
import { holdWorkspacePreparationSnapshot } from "../agents/workspace-preparation-queue.test-support.js";
import { ensureAgentWorkspace } from "../agents/workspace.js";
import { getRegistryWorktree } from "../agents/worktrees/registry.test-support.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createThrowingTestRuntime } from "./test-runtime-config-helpers.js";

const configIoMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  readConfigFileSnapshotForWrite: vi.fn(),
}));

// mock-isolation: Worktree cases supply workspace config in memory without loading persisted config.
vi.mock("../config/io.js", () => ({
  captureRuntimeConfigAsyncReader: () => async () => configIoMocks.loadConfig(),
  getRuntimeConfig: configIoMocks.loadConfig,
  loadConfig: configIoMocks.loadConfig,
  readConfigFileSnapshotForWrite: configIoMocks.readConfigFileSnapshotForWrite,
}));

const execFileAsync = promisify(execFile);
const runtime = createThrowingTestRuntime();
const sessionKey = "agent:main:worktree-race";
const actualWorkspace =
  await vi.importActual<typeof import("../agents/workspace.js")>("../agents/workspace.js");

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

async function initializeRepository(root: string): Promise<string> {
  const repo = path.join(root, "repo");
  await fs.mkdir(repo, { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "OpenClaw Test");
  await git(repo, "config", "user.email", "openclaw-test@example.invalid");
  await fs.writeFile(path.join(repo, "README.md"), "base\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  return await fs.realpath(repo);
}

function mockConfig(home: string) {
  const workspace = path.join(home, "openclaw");
  const storePath = path.join(home, "sessions.json");
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
        models: { "anthropic/claude-opus-4-6": {} },
        workspace,
      },
    },
    session: { store: storePath, mainKey: "main" },
  };
  configIoMocks.loadConfig.mockReturnValue(cfg);
  return { workspace, storePath };
}

async function createSessionWorktree(home: string, bind = false) {
  const { storePath } = mockConfig(home);
  const created = await managedWorktrees.create({
    repoRoot: await initializeRepository(home),
    name: "race-session",
    baseRef: "main",
    ownerKind: "session",
    ownerId: sessionKey,
  });
  const nested = path.join(created.path, "workspace");
  await fs.mkdir(nested);
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey, storePath },
    {
      sessionId: "session-worktree-race",
      updatedAt: Date.now(),
      spawnedCwd: nested,
      ...(bind
        ? { worktree: { id: created.id, branch: created.branch, repoRoot: created.repoRoot } }
        : {}),
    },
  );
  return { id: created.id, nested };
}

const prepareSession = () =>
  prepareAgentCommandExecution({ message: "resume in worktree", sessionKey }, runtime);

describe("agent command worktree admission", () => {
  beforeEach(() => {
    vi.mocked(ensureAgentWorkspace).mockReset().mockResolvedValue({ dir: "" });
    clearSessionStoreCacheForTest();
  });

  afterEach(closeOpenClawStateDatabaseForTest);

  it("rejects an aborted command queued behind workspace preparation before scaffolding", async ({
    signal,
  }) => {
    const waitFor = (gate: PromiseLike<void>, operation: PromiseLike<unknown>, message: string) =>
      withinTest(awaitGateBeforeSettlement(gate, operation, message), signal);
    await withTempHome(async (home) => {
      const { workspace: workspaceDir } = mockConfig(home);
      await fs.mkdir(workspaceDir);
      const held = holdWorkspacePreparationSnapshot(workspaceDir);
      const leader = actualWorkspace.ensureAgentWorkspace({ dir: workspaceDir });
      void leader.catch(() => undefined);
      let preparing: ReturnType<typeof prepareAgentCommandExecution> | undefined;
      try {
        await waitFor(held.entered, leader, "Workspace leader did not enter");
        const queued = createDeferred();
        vi.mocked(ensureAgentWorkspace).mockImplementationOnce((params) => {
          const pending = actualWorkspace.ensureAgentWorkspace(params);
          queued.resolve();
          return pending;
        });
        const controller = new AbortController();
        const reason = new Error("Command source retired while workspace preparation was queued");
        const options = {
          message: "prepare the workspace",
          agentId: "main",
          sessionId: "queued-workspace-command",
          abortSignal: controller.signal,
        };
        preparing = prepareAgentCommandExecution(options, runtime);
        void preparing.catch(() => undefined);
        await waitFor(queued.promise, preparing, "Command did not queue workspace preparation");
        options.abortSignal = new AbortController().signal;
        controller.abort(reason);
        held.release();
        await leader;
        await expect(preparing).rejects.toMatchObject({
          name: "AbortError",
          message: "Operation aborted",
          cause: reason,
        });
        expect(await fs.readdir(workspaceDir)).toEqual([]);
      } finally {
        await held.dispose([leader, preparing]);
      }
    });
  });

  it("holds the lease through workspace preparation so a racing removal is rejected", async () => {
    await withTempHome(async (home) => {
      const { id, nested } = await createSessionWorktree(home);

      const paused = createDeferred();
      const pauseReached = createDeferred();
      vi.mocked(ensureAgentWorkspace).mockImplementationOnce(async (params) => {
        pauseReached.resolve();
        await paused.promise;
        return { dir: params?.dir ?? "" };
      });

      const preparing = prepareSession();
      await pauseReached.promise;
      try {
        await expect(managedWorktrees.remove({ id, reason: "idle-gc" })).rejects.toThrow(
          "worktree is busy",
        );
        await expect(fs.stat(nested)).resolves.toBeDefined();
      } finally {
        paused.resolve();
        const prepared = await preparing;
        await prepared.runLease?.release();
      }
      await expect(managedWorktrees.remove({ id, reason: "idle-gc" })).resolves.toMatchObject({
        removed: true,
      });
    });
  });

  it("fails closed before workspace setup when the session's bound worktree was removed", async () => {
    await withTempHome(async (home) => {
      const { id } = await createSessionWorktree(home, true);
      await managedWorktrees.remove({ id, reason: "manual-delete", allowSnapshotLoss: true });
      expect(getRegistryWorktree(process.env, id)?.removedAt).toBeDefined();
      await expect(prepareSession()).rejects.toThrow("managed worktree was removed");
      expect(ensureAgentWorkspace).not.toHaveBeenCalled();
    });
  });
});
