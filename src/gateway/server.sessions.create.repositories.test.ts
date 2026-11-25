import { getEventListeners } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { appendTranscriptMessage, loadSessionEntry } from "../config/sessions/session-accessor.js";
import * as gitWorker from "../infra/git-worker.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { loadTestSessionPullRequests as loadControlUiSessionPullRequests } from "./control-ui-session-prs.test-support.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";
import { controlUiClient } from "./server.sessions.create.projects.test-support.js";
import { dispatchInboundMessageMock, testState } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const projectCloneMocks = vi.hoisted(() => ({ materialize: vi.fn() }));
vi.mock("../projects/project-clone.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../projects/project-clone.js")>();
  return { ...actual, materializeProjectClone: projectCloneMocks.materialize };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(async () => {
  await disposeSessionReadContexts();
  projectCloneMocks.materialize.mockReset();
  dispatchInboundMessageMock.mockReset();
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = undefined;
  vi.unstubAllGlobals();
});

test("sessions.create retains a cloud repository across replay without creating a Gateway checkout", async () => {
  const root = tempDirs.make("openclaw-session-cloud-repository-");
  const workspace = path.join(root, "must-not-be-created");
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  const repository = { url: "git@github.com:OpenClaw/OpenClaw.git", ref: "release/next" };
  const created = await directSessionReq<{
    key: string;
    entry: { repositoryWorkspaceId: string };
  }>("sessions.create", { agentId: "main", repository }, controlUiClient);
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const { key, entry } = created.payload!;
  expect(entry.repositoryWorkspaceId).toEqual(expect.any(String));
  expect(created.payload).not.toHaveProperty("worktree");
  const saved = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
  expect(saved).toMatchObject({ repositoryWorkspaceId: entry.repositoryWorkspaceId });
  for (const field of [
    "worktree",
    "projectId",
    "pendingProjectGitUrl",
    "pendingWorktree",
    "spawnedCwd",
    "sessionRoot",
    "sessionDiffBaselineCapture",
  ]) {
    expect(saved).not.toHaveProperty(field);
  }
  await disposeSessionReadContexts();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  const replayOptions = { ...controlUiClient, context: {} };
  const replay = await directSessionReq<{ entry: { repositoryWorkspaceId: string } }>(
    "sessions.create",
    { agentId: "main", key, repository },
    replayOptions,
  );
  expect(replay.ok, JSON.stringify(replay.error)).toBe(true);
  expect(replay.payload?.entry.repositoryWorkspaceId).toBe(entry.repositoryWorkspaceId);
  const listed = await directSessionReq<{
    sessions: Array<{
      key: string;
      repositoryWorkspaceId?: string;
      repository?: { url: string; ref?: string; branch: string };
    }>;
  }>("sessions.list", { agentId: "main", limit: 100 }, replayOptions);
  expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
  expect(listed.payload?.sessions.find((row) => row.key === key)).toMatchObject({
    repositoryWorkspaceId: entry.repositoryWorkspaceId,
    repository: {
      url: "https://github.com/openclaw/openclaw.git",
      ref: "release/next",
      branch: expect.stringMatching(/^openclaw\//u),
    },
  });
  const gitRead = vi
    .spyOn(gitWorker, "runGitWorkerOperation")
    .mockImplementation(async (operation) => {
      if (operation.type === "pull-request.branch-comparison") {
        return { statsBase: null, creatable: false, equalPushedTips: false, complete: true };
      }
      if (operation.type === "checkout.revision") {
        return { key: "unchanged" };
      }
      if (operation.type === "checkout.context") {
        return {
          root: operation.input.root,
          owner: "openclaw",
          repo: "openclaw",
          branch: "previous-local-branch",
          defaultBranch: "main",
        };
      }
      if (operation.type === "pull-request.branch-facts") {
        return undefined;
      }
      throw new Error("Unexpected Git operation");
    });
  onTestFinished(() => gitRead.mockRestore());
  // The manual Gateway fixture disables bundles. Only this public-API probe needs GitHub.
  await withEnvAsync(
    {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: undefined,
    },
    async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json([]));
      vi.stubGlobal("fetch", fetchImpl);
      const cacheLifetime = new AbortController();
      onTestFinished(() => cacheLifetime.abort());
      const params = { sessionKey: key, agentId: "main" };
      await loadControlUiSessionPullRequests(params, {
        cacheSignal: cacheLifetime.signal,
      });
      const repositoryPins = getEventListeners(cacheLifetime.signal, "abort").length;
      expect(repositoryPins).toBeGreaterThan(0);
      await loadControlUiSessionPullRequests(params, {
        cacheSignal: cacheLifetime.signal,
        resolveGitRoot: async () => workspace,
      });
      expect(getEventListeners(cacheLifetime.signal, "abort")).toHaveLength(repositoryPins);
      gitRead.mockClear();
      const preview = await loadControlUiSessionPullRequests(params, {
        cacheSignal: cacheLifetime.signal,
      });
      expect(getEventListeners(cacheLifetime.signal, "abort")).toHaveLength(repositoryPins);
      expect(preview.branch, JSON.stringify(preview)).toMatchObject({
        owner: "openclaw",
        repo: "openclaw",
        branch: `openclaw/${entry.repositoryWorkspaceId}`,
      });
      expect(gitRead).not.toHaveBeenCalled();
      expect(fetchImpl).toHaveBeenCalled();
      cacheLifetime.abort();
      expect(getEventListeners(cacheLifetime.signal, "abort")).toHaveLength(0);
    },
  );
  for (const changedSource of [
    undefined,
    { ...repository, ref: "main" },
    { url: "https://github.com/octocat/hello-world.git" },
  ]) {
    const changed = await directSessionReq(
      "sessions.create",
      { agentId: "main", key, ...(changedSource ? { repository: changedSource } : {}) },
      controlUiClient,
    );
    expect(changed).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  }
  expect(await fs.stat(workspace).catch(() => undefined)).toBeUndefined();
  expect(projectCloneMocks.materialize).not.toHaveBeenCalled();
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
});

test("repository branches preserve their prefix on replay and use the current prefix on fork", async () => {
  const { storePath } = await createSessionStoreDir();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  let config = { ...getRuntimeConfig(), repositoryBranchPrefix: "clawson" };
  const options = { ...controlUiClient, context: { getRuntimeConfig: () => config } };
  const repository = { url: "https://github.com/openclaw/openclaw.git", ref: "main" };
  const created = await directSessionReq<{
    key: string;
    entry: { sessionId: string; repositoryWorkspaceId: string };
  }>("sessions.create", { agentId: "main", repository }, options);
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const { key, entry } = created.payload!;
  config = { ...config, repositoryBranchPrefix: "renamed" };
  const replay = await directSessionReq(
    "sessions.create",
    { agentId: "main", key, repository },
    options,
  );
  expect(replay.ok, JSON.stringify(replay.error)).toBe(true);
  await appendTranscriptMessage(
    { agentId: "main", sessionKey: key, sessionId: entry.sessionId, storePath },
    { eventId: "user-entry", parentId: null, message: { role: "user", content: "Fork here." } },
  );
  const forked = await directSessionReq<{ sessionKey: string }>(
    "sessions.fork",
    { sessionKey: key, entryId: "user-entry" },
    options,
  );
  expect(forked.ok, JSON.stringify(forked.error)).toBe(true);
  const listed = await directSessionReq<{
    sessions: Array<{
      key: string;
      repositoryWorkspaceId?: string;
      repository?: { branch: string };
    }>;
  }>("sessions.list", { agentId: "main", limit: 100 }, options);
  expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
  expect(listed.payload?.sessions.find((row) => row.key === key)?.repository?.branch).toBe(
    `clawson/${entry.repositoryWorkspaceId}`,
  );
  const forkRow = listed.payload?.sessions.find((row) => row.key === forked.payload?.sessionKey);
  expect(forkRow?.repositoryWorkspaceId).toEqual(expect.any(String));
  expect(forkRow?.repositoryWorkspaceId).not.toBe(entry.repositoryWorkspaceId);
  expect(forkRow?.repository?.branch).toBe(`renamed/${forkRow?.repositoryWorkspaceId}`);
});

test.each([
  { repository: { url: "file:///tmp/repository" } },
  {
    repository: { url: "https://github.com/openclaw/openclaw.git", ref: "--upload-pack=anything" },
  },
  { worktree: true },
  { message: "Start before dispatch" },
])(
  "sessions.create rejects conflicting cloud repository input before admission: %j",
  async (options) => {
    await createSessionStoreDir();
    const created = await directSessionReq(
      "sessions.create",
      {
        agentId: "main",
        repository: { url: "https://github.com/openclaw/openclaw.git" },
        ...options,
      },
      controlUiClient,
    );
    expect(created).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect(projectCloneMocks.materialize).not.toHaveBeenCalled();
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  },
);
