import { execFile } from "node:child_process";
import fsSync from "node:fs";
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

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: configIoMocks.loadConfig,
  loadConfig: configIoMocks.loadConfig,
  readConfigFileSnapshotForWrite: configIoMocks.readConfigFileSnapshotForWrite,
}));

const execFileAsync = promisify(execFile);
const runtime = createThrowingTestRuntime();
const sessionKey = "agent:main:worktree-race";
const actualWorkspace =
  await vi.importActual<typeof import("../agents/workspace.js")>("../agents/workspace.js");

function recordProof(line: string): void {
  const out = process.env.OPENCLAW_PROOF_OUT;
  if (out) {
    fsSync.appendFileSync(out, `${line}\n`);
  }
}

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

function mockConfig(home: string, storePath: string): OpenClawConfig {
  const cfg = {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
        models: { "anthropic/claude-opus-4-6": {} },
        workspace: path.join(home, "openclaw"),
      },
    },
    session: { store: storePath, mainKey: "main" },
  } as OpenClawConfig;
  configIoMocks.loadConfig.mockReturnValue(cfg);
  return cfg;
}

async function seedSession(
  storePath: string,
  spawnedCwd: string,
  worktree?: { id: string; branch: string; repoRoot: string },
): Promise<void> {
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey, storePath },
    {
      sessionId: "session-worktree-race",
      updatedAt: Date.now(),
      spawnedCwd,
      ...(worktree ? { worktree } : {}),
    },
  );
}

async function createSessionWorktree(
  home: string,
): Promise<{ id: string; path: string; branch: string; repoRoot: string }> {
  const repo = await initializeRepository(home);
  const created = await managedWorktrees.create({
    repoRoot: repo,
    name: "race-session",
    ownerKind: "session",
    ownerId: sessionKey,
  });
  return { id: created.id, path: created.path, branch: created.branch, repoRoot: created.repoRoot };
}

describe("agent command worktree admission", () => {
  beforeEach(() => {
    vi.mocked(ensureAgentWorkspace).mockReset();
    vi.mocked(ensureAgentWorkspace).mockResolvedValue({ dir: "" });
    clearSessionStoreCacheForTest();
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("rejects an aborted command queued behind workspace preparation before scaffolding", async ({
    signal,
  }) => {
    await withTempHome(async (home) => {
      mockConfig(home, path.join(home, "sessions.json"));
      const workspaceDir = path.join(home, "openclaw");
      await fs.mkdir(workspaceDir);
      const held = holdWorkspacePreparationSnapshot(workspaceDir);
      const leader = actualWorkspace.ensureAgentWorkspace({ dir: workspaceDir });
      void leader.catch(() => undefined);
      let preparing: ReturnType<typeof prepareAgentCommandExecution> | undefined;
      try {
        await withinTest(
          awaitGateBeforeSettlement(held.entered, leader, "Workspace leader did not enter"),
          signal,
        );
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
        await withinTest(
          awaitGateBeforeSettlement(
            queued.promise,
            preparing,
            "Command did not queue workspace preparation",
          ),
          signal,
        );
        options.abortSignal = new AbortController().signal;
        controller.abort(reason);
        held.release();
        await leader;
        const error = await preparing.catch((caught: unknown) => caught);
        expect(await fs.readdir(workspaceDir)).toEqual([]);
        expect(error).toMatchObject({
          name: "AbortError",
          message: "Operation aborted",
          cause: reason,
        });
      } finally {
        await held.dispose([leader, preparing]);
      }
    });
  });

  it("holds the lease through workspace preparation so a racing removal is rejected", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      mockConfig(home, storePath);
      const created = await createSessionWorktree(home);
      const nested = path.join(created.path, "workspace");
      await fs.mkdir(nested);
      await seedSession(storePath, nested);

      let releasePause = () => {};
      const paused = new Promise<void>((resolve) => {
        releasePause = resolve;
      });
      let reachPause = () => {};
      const pauseReached = new Promise<void>((resolve) => {
        reachPause = resolve;
      });
      vi.mocked(ensureAgentWorkspace).mockImplementationOnce(async (params) => {
        reachPause();
        await paused;
        return { dir: params?.dir ?? "" };
      });

      const preparing = prepareAgentCommandExecution(
        { message: "resume in worktree", sessionKey },
        runtime,
      );
      await pauseReached;

      let removalDuringPreparation: string;
      try {
        const removed = await managedWorktrees.remove({ id: created.id, reason: "idle-gc" });
        removalDuringPreparation = `removed=${removed.removed}`;
      } catch (error) {
        removalDuringPreparation = `rejected: ${(error as Error).message}`;
      }
      const checkoutSurvivedPreparation = fsSync.existsSync(nested);
      recordProof(`removal during production workspace preparation: ${removalDuringPreparation}`);
      recordProof(`managed checkout survived preparation: ${checkoutSurvivedPreparation}`);

      releasePause();
      const prepared = await preparing;
      await prepared.runLease?.release();

      expect(removalDuringPreparation).toContain("worktree is busy");
      expect(checkoutSurvivedPreparation).toBe(true);
      expect((await managedWorktrees.remove({ id: created.id, reason: "idle-gc" })).removed).toBe(
        true,
      );
    });
  });

  it("fails closed before workspace setup when the session's bound worktree was removed", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      mockConfig(home, storePath);
      const created = await createSessionWorktree(home);
      const nested = path.join(created.path, "workspace");
      await fs.mkdir(nested);
      await seedSession(storePath, nested, {
        id: created.id,
        branch: created.branch,
        repoRoot: created.repoRoot,
      });
      await managedWorktrees.remove({
        id: created.id,
        reason: "manual-delete",
        allowSnapshotLoss: true,
      });
      expect(getRegistryWorktree(process.env, created.id)?.removedAt).toBeDefined();

      let preparationResult: string;
      try {
        await prepareAgentCommandExecution({ message: "resume in worktree", sessionKey }, runtime);
        preparationResult = "preparation proceeded without its checkout";
      } catch (error) {
        preparationResult = `preparation fails: ${(error as Error).message}`;
      }
      const workspaceSetupRan = vi.mocked(ensureAgentWorkspace).mock.calls.length > 0;
      recordProof(`admission for a removed authoritative binding: ${preparationResult}`);
      recordProof(`workspace setup ran on the removed worktree: ${workspaceSetupRan}`);

      expect(preparationResult).toContain("managed worktree was removed");
      expect(workspaceSetupRan).toBe(false);
    });
  });
});
