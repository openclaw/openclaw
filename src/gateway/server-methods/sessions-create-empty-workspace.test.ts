import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { controlUiClient } from "../server.sessions.create.projects.test-support.js";
import { testState } from "../test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = undefined;
});

test("sessions.create starts an owned empty workspace without reading the agent folder", async () => {
  const root = tempDirs.make("openclaw-session-empty-workspace-");
  const workspace = path.join(root, "agent-workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "private.txt"), "Must stay in the agent folder.");
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:dashboard:empty-workspace";
  const params = { key, agentId: "main", message: "", worktree: true, worktreeSource: "empty" };

  const created = await directSessionReq<{ key: string }>(
    "sessions.create",
    params,
    controlUiClient,
  );

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const owned = managedWorktrees.findLiveByOwner("session", key);
  expect(owned).toBeDefined();
  try {
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toMatchObject({
      sessionRoot: owned!.path,
      spawnedCwd: owned!.path,
      worktree: { id: owned!.id, repoRoot: owned!.repoRoot },
    });
    expect(await fs.readdir(owned!.path)).toEqual([".git"]);
    expect(await fs.readdir(workspace)).toEqual(["private.txt"]);
    await fs.writeFile(path.join(owned!.path, "result.txt"), "Keep this work.");

    const replay = await directSessionReq("sessions.create", params, controlUiClient);

    expect(replay.ok, JSON.stringify(replay.error)).toBe(true);
    expect(managedWorktrees.findLiveByOwner("session", key)?.id).toBe(owned!.id);
    expect(await fs.readFile(path.join(owned!.path, "result.txt"), "utf8")).toBe("Keep this work.");
  } finally {
    if (owned) {
      await managedWorktrees.remove({
        id: owned.id,
        reason: "test-cleanup",
        allowSnapshotLoss: true,
      });
    }
  }
});

test.each([
  { worktree: false },
  { cwd: "/some/folder" },
  { projectId: "project" },
  { projectGitUrl: "https://github.com/openclaw/openclaw.git" },
  { repository: { url: "https://github.com/openclaw/openclaw.git" } },
  { catalogId: "external" },
  { execNode: "device" },
  { worktreeBaseRef: "other-session-branch" },
])("sessions.create rejects conflicting empty workspace selection %j", async (conflict) => {
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:dashboard:conflicting-empty-workspace";
  const created = await directSessionReq(
    "sessions.create",
    { key, worktree: true, worktreeSource: "empty", ...conflict },
    controlUiClient,
  );

  expect(created).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: expect.stringContaining("worktreeSource=empty") },
  });
  expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toBeUndefined();
});
