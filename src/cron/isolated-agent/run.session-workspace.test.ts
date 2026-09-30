import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createCoreCodingTools } from "../../agents/core-coding-tools.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import type { ManagedWorktreeRecord } from "../../agents/worktrees/types.js";
import {
  interruptSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  ensureAgentWorkspaceMock,
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  loadSessionEntryMock,
  makeCronSession,
  makeCronSessionEntry,
  mockRunCronFallbackPassthrough,
  resolveCronSessionMock,
  resolveDeliveryTargetMock,
  runEmbeddedAgentMock,
  runCliAgentMock,
} from "./run.test-harness.js";

const worktrees = vi.hoisted(() => ({
  read: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(async () => {}),
}));
vi.mock("../../agents/worktrees/registry-read.js", () => ({
  readRegistryWorktree: worktrees.read,
}));
vi.mock("../../agents/worktrees/run-lease.js", () => ({
  acquireWorktreeRunLease: worktrees.acquire,
}));

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionKey = "agent:default:project-dashboard";

function bindSession(workspaceDir: string, managed = false) {
  const binding = {
    id: "workspace-1",
    branch: "fix/session-workspace",
    repoRoot: path.dirname(workspaceDir),
  };
  const entry = makeCronSessionEntry({
    spawnedCwd: workspaceDir,
    ...(managed ? { worktree: binding } : {}),
  });
  loadSessionEntryMock.mockReturnValue(entry);
  const session = makeCronSession({
    initialSessionEntry: entry,
    sessionEntry: { ...entry },
    isNewSession: false,
  });
  resolveCronSessionMock.mockReturnValue(session);
  const record = {
    ...binding,
    path: workspaceDir,
    name: "dashboard",
    repoFingerprint: "fixture",
    baseRef: "main",
    ownerKind: "session",
    ownerId: sessionKey,
    createdAt: 1,
    lastActiveAt: 1,
  } satisfies ManagedWorktreeRecord;
  worktrees.read.mockResolvedValue(record);
  return { entry, record, session };
}

function run(sessionTarget = `session:${sessionKey}`, key = sessionKey) {
  return runCronIsolatedAgentTurn(
    makeIsolatedAgentParamsFixture({
      sessionKey: key,
      cfg: { tools: { fs: { workspaceOnly: true } }, plugins: { enabled: false } },
      job: makeIsolatedAgentJobFixture({
        sessionTarget,
        delivery: { mode: "none" },
        payload: { kind: "agentTurn", message: "read the saved report", toolsAllow: ["read"] },
      }),
    }),
  );
}

describe("session-bound cron workspace", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });
  beforeEach(() => {
    worktrees.read.mockReset();
    worktrees.acquire.mockReset();
    worktrees.release.mockClear();
    worktrees.acquire.mockResolvedValue({
      id: "workspace-1",
      token: "***",
      release: worktrees.release,
    });
    ensureAgentWorkspaceMock.mockImplementation(async ({ dir }: { dir: string }) => ({ dir }));
    mockRunCronFallbackPassthrough();
  });

  it("reads its bound worktree, denies outside files, and keeps silent delivery and tool restrictions", async () => {
    const root = tempDirs.make("cron-bound-workspace-");
    const workspaceDir = path.join(root, "worktree");
    await fs.mkdir(workspaceDir);
    await fs.writeFile(path.join(workspaceDir, "report.txt"), "saved report");
    const outside = path.join(root, "outside.txt");
    await fs.writeFile(outside, "synthetic outside file");
    bindSession(workspaceDir, true);
    runEmbeddedAgentMock.mockImplementationOnce(async (params: RunEmbeddedAgentParams) => {
      expect(params.workspaceDir).toBe(workspaceDir);
      expect(params.cwd).toBe(workspaceDir);
      expect(params.config?.tools?.fs?.workspaceOnly).toBe(true);
      expect(params.toolsAllow).toEqual(["read"]);
      expect(worktrees.release).not.toHaveBeenCalled();
      const read = createCoreCodingTools({
        codingRoot: params.cwd ?? params.workspaceDir,
        containmentRoot: params.workspaceDir,
        includeBaseCodingTools: true,
        shellTools: "disabled",
        workspaceOnly: true,
        readOnly: true,
        applyPatchEnabled: false,
        applyPatchWorkspaceOnly: true,
        execDefaults: {},
        processDefaults: {},
      }).find((tool) => tool.name === "read");
      expect(read).toBeDefined();
      const result = await read!.execute("inside", { path: "report.txt" });
      expect(result).toMatchObject({
        content: expect.arrayContaining([
          expect.objectContaining({ type: "text", text: expect.stringContaining("saved report") }),
        ]),
      });
      await expect(read!.execute("outside", { path: outside })).rejects.toThrow(
        /outside|escapes sandbox root/i,
      );
      return { payloads: [{ text: "refreshed" }], meta: { agentMeta: {} } };
    });
    const result = await run();
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok" });
    expect(worktrees.acquire).toHaveBeenCalledWith("workspace-1");
    expect(worktrees.release).toHaveBeenCalledOnce();
    expect(resolveDeliveryTargetMock).not.toHaveBeenCalled();
  });

  it.each(["missing", "retired", "different branch", "different root"])(
    "rejects a %s worktree before file tools start",
    async (condition) => {
      const workspaceDir = tempDirs.make("cron-invalid-worktree-");
      const { record } = bindSession(workspaceDir, true);
      if (condition === "missing") {
        worktrees.read.mockResolvedValue(undefined);
      }
      if (condition === "retired") {
        worktrees.read.mockResolvedValue({ ...record, removedAt: 2 });
      }
      if (condition === "different branch") {
        worktrees.read.mockResolvedValue({ ...record, branch: "other" });
      }
      if (condition === "different root") {
        worktrees.read.mockResolvedValue({
          ...record,
          path: tempDirs.make("cron-different-worktree-"),
        });
      }
      const result = await run();
      expect(result).toMatchObject({ status: "error" });
      expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(ensureAgentWorkspaceMock).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "keeps a nested cwd within its bound worktree (spawned=%s)",
    async (spawned) => {
      const root = tempDirs.make("cron-nested-worktree-");
      const cwd = path.join(root, "package");
      await fs.mkdir(cwd);
      const { entry, record, session } = bindSession(cwd, true);
      worktrees.read.mockResolvedValue({ ...record, path: root });
      if (spawned) {
        entry.spawnedBy = "agent:default:parent";
        entry.spawnedWorkspaceDir = root;
        Object.assign(session.sessionEntry, entry);
      }
      expect(await run()).toMatchObject({ status: "ok" });
      expect(runEmbeddedAgentMock).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceDir: spawned ? root : cwd, cwd }),
      );
      expect(worktrees.release).toHaveBeenCalledOnce();
    },
  );

  it("passes the same bound workspace to a CLI runner", async () => {
    const workspaceDir = tempDirs.make("cron-cli-workspace-");
    bindSession(workspaceDir, true);
    isCliProviderMock.mockReturnValue(true);
    runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "refreshed" }],
      meta: { agentMeta: {} },
    });
    const result = await run();
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok" });
    expect(runCliAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir, cwd: workspaceDir }),
    );
    expect(worktrees.release).toHaveBeenCalledOnce();
    expect(resolveDeliveryTargetMock).not.toHaveBeenCalled();
  });

  it("releases the worktree when workspace provisioning fails", async () => {
    bindSession(tempDirs.make("cron-provision-failure-"), true);
    ensureAgentWorkspaceMock.mockRejectedValueOnce(new Error("workspace unavailable"));
    await expect(run()).rejects.toThrow("workspace unavailable");
    expect(worktrees.release).toHaveBeenCalledOnce();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("revalidates after lease acquisition and releases a rejected lease", async () => {
    const workspaceDir = tempDirs.make("cron-replaced-worktree-");
    const { record } = bindSession(workspaceDir, true);
    worktrees.read.mockResolvedValueOnce(record).mockResolvedValueOnce(undefined);
    expect(await run()).toMatchObject({ status: "error" });
    expect(worktrees.release).toHaveBeenCalledOnce();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("drains admitted workspace preparation before a lifecycle owner removes its binding", async () => {
    const workspaceDir = tempDirs.make("cron-removed-session-");
    const { entry, record, session } = bindSession(workspaceDir, true);
    const reading = createDeferred();
    const finishRead = createDeferred();
    worktrees.read.mockImplementation(async () => {
      reading.resolve();
      await finishRead.promise;
      return record;
    });
    const pending = run();
    const stopped = expect(pending).rejects.toThrow("agent run aborted for restart");
    await reading.promise;
    const target = {
      scope: session.storePath,
      identities: [sessionKey, entry.sessionId],
    };
    let bindingRemoved = false;
    const mutation = runExclusiveSessionLifecycleMutation({
      ...target,
      prepare: async () => {
        const drained = interruptSessionWorkAdmissions(target);
        expect(bindingRemoved).toBe(false);
        finishRead.resolve();
        await drained;
      },
      run: async () => {
        bindingRemoved = true;
        loadSessionEntryMock.mockReturnValue(undefined);
      },
    });
    await Promise.all([stopped, mutation]);
    expect(bindingRemoved).toBe(true);
    expect(worktrees.acquire).not.toHaveBeenCalled();
    expect(ensureAgentWorkspaceMock).not.toHaveBeenCalled();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "rejects a mismatched target before workspace use (existing=%s)",
    async (existing) => {
      if (existing) {
        bindSession(tempDirs.make("cron-wrong-session-"));
      }
      expect(await run("session:agent:default:another-dashboard")).toMatchObject({
        status: "error",
      });
      expect(ensureAgentWorkspaceMock).not.toHaveBeenCalled();
      expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    },
  );

  it("starts a new custom session in the configured workspace without resolving a worktree", async () => {
    loadSessionEntryMock.mockReturnValue(undefined);
    resolveCronSessionMock.mockReturnValue(makeCronSession());
    expect(await run("session:custom-id", "custom-id")).toMatchObject({ status: "ok" });
    expect(runEmbeddedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:default:custom-id",
        workspaceDir: "/tmp/workspace",
      }),
    );
    expect(worktrees.read).not.toHaveBeenCalled();
    expect(worktrees.acquire).not.toHaveBeenCalled();
    expect(resolveDeliveryTargetMock).not.toHaveBeenCalled();
  });

  it("does not recreate a missing existing workspace", async () => {
    const workspaceDir = path.join(tempDirs.make("cron-lost-workspace-"), "missing");
    bindSession(workspaceDir, true);
    await expect(run()).rejects.toThrow(/ENOENT/);
    expect(ensureAgentWorkspaceMock).not.toHaveBeenCalled();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(worktrees.acquire).not.toHaveBeenCalled();
  });

  it.each(["current", "isolated"])("keeps the configured workspace for %s runs", async (target) => {
    const workspaceDir = tempDirs.make("cron-detached-source-");
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        sessionEntry: makeCronSessionEntry({ spawnedCwd: workspaceDir }),
      }),
    );
    loadSessionEntryMock.mockReturnValue(undefined);
    const result = await run(target);
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok" });
    expect(runEmbeddedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: "/tmp/workspace" }),
    );
    expect(worktrees.read).not.toHaveBeenCalled();
    expect(worktrees.acquire).not.toHaveBeenCalled();
  });
});
