import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ManagedWorktreeRecord } from "../../agents/worktrees/types.js";
import {
  interruptSessionControllerEffects,
  runSessionMutation,
} from "../../sessions/session-controller.lifecycle.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  ensureAgentWorkspaceMock,
  loadRunCronIsolatedAgentTurn,
  loadSessionEntryMock,
  makeCronSession,
  makeCronSessionEntry,
  mockRunCronFallbackPassthrough,
  resolveCronSessionMock,
  resolveDeliveryTargetMock,
  runEmbeddedAgentMock,
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

function bindSession(managed = true, workspaceDir = tempDirs.make("cron-workspace-")) {
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
    ownerKind: "session",
    ownerId: sessionKey,
  } satisfies Pick<ManagedWorktreeRecord, keyof typeof binding | "path" | "ownerKind" | "ownerId">;
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

setupRunCronIsolatedAgentTurnSuite({ fast: true });
beforeEach(() => {
  worktrees.read.mockReset();
  worktrees.acquire.mockReset();
  worktrees.release.mockClear();
  worktrees.acquire.mockResolvedValue({ release: worktrees.release });
  ensureAgentWorkspaceMock.mockImplementation(async ({ dir }: { dir: string }) => ({ dir }));
  mockRunCronFallbackPassthrough();
});

it.each(["different root", "mismatched target", "provisioning failure", "revoked lease"])(
  "rejects %s before file tools start",
  async (mismatch) => {
    const { record } = bindSession(mismatch !== "mismatched target");
    if (mismatch === "different root") {
      worktrees.read.mockResolvedValue({ ...record, path: tempDirs.make("cron-other-") });
    } else if (mismatch === "revoked lease") {
      worktrees.read.mockResolvedValueOnce(record).mockResolvedValueOnce(undefined);
    } else if (mismatch === "provisioning failure") {
      ensureAgentWorkspaceMock.mockRejectedValueOnce(new Error("workspace unavailable"));
    }
    const target =
      mismatch === "mismatched target" ? "agent:default:another-dashboard" : sessionKey;
    const pending = run(`session:${target}`);
    if (mismatch === "provisioning failure") {
      await expect(pending).rejects.toThrow("workspace unavailable");
    } else {
      expect(await pending).toMatchObject({ status: "error" });
      if (mismatch !== "revoked lease") {
        expect(ensureAgentWorkspaceMock).not.toHaveBeenCalled();
      }
    }
    if (mismatch === "provisioning failure" || mismatch === "revoked lease") {
      expect(worktrees.release).toHaveBeenCalledOnce();
    }
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  },
);

it("drains admitted workspace preparation before a lifecycle owner removes its binding", async () => {
  const { entry, record, session } = bindSession();
  const reading = createDeferred();
  const finishRead = createDeferred();
  worktrees.read.mockImplementation(async () => {
    reading.resolve();
    await finishRead.promise;
    return record;
  });
  const reason = new Error("cron workspace binding removed");
  const pending = run();
  const stopped = expect(pending).rejects.toBe(reason);
  await reading.promise;
  const target = {
    scope: session.storePath,
    identities: [sessionKey, entry.sessionId],
  };
  let bindingRemoved = false;
  const mutation = runSessionMutation({
    ...target,
    prepare: async () => {
      const drained = interruptSessionControllerEffects({ ...target, reason });
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

it.each(["custom", "current"])("keeps the configured workspace for %s runs", async (target) => {
  const custom = target === "custom";
  const sessionEntry = makeCronSessionEntry(
    custom ? {} : { spawnedCwd: tempDirs.make("cron-detached-source-") },
  );
  resolveCronSessionMock.mockReturnValue(makeCronSession({ sessionEntry }));
  loadSessionEntryMock.mockReturnValue(undefined);
  const result = await run(
    custom ? "session:custom-id" : "current",
    custom ? "custom-id" : sessionKey,
  );
  expect(result, JSON.stringify(result)).toMatchObject({ status: "ok" });
  expect(runEmbeddedAgentMock).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceDir: "/tmp/workspace",
      ...(custom ? { sessionKey: "agent:default:custom-id" } : {}),
    }),
  );
  expect(worktrees.read).not.toHaveBeenCalled();
  expect(worktrees.acquire).not.toHaveBeenCalled();
  if (custom) {
    expect(resolveDeliveryTargetMock).not.toHaveBeenCalled();
  }
});
