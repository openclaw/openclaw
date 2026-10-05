import { getEventListeners } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { installFactoryRestartRepositoryFixture } from "../agents/main-session-recovery/main-session-recovery-factory-read.test-support.js";
import { createOriginalIssuerFixture } from "../agents/main-session-recovery/main-session-recovery-original-issuer.test-support.js";
import { refreshPreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import * as gitWorker from "../infra/git-worker.js";
import { NodeWorkerWorkspaceRuntime } from "../node-host/node-worker-workspace.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
} from "../plugins/runtime.js";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { setCanonicalUserProfileRole } from "../state/user-profile-writes.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { loadTestSessionPullRequests as loadControlUiSessionPullRequests } from "./control-ui-session-prs.test-support.js";
import { closeGatewayDeviceRevocation } from "./device-revocation.js";
import { dispatchGatewayRequestInProcess } from "./server-in-process-dispatch.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";
import { controlUiClient } from "./server.sessions.create.projects.test-support.js";
import { dispatchInboundMessageMock, testState } from "./test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import { createNodeWorkerRepositoryPreparation } from "./worker-environments/node-worker-repository-preparation.js";

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
  vi.unstubAllEnvs();
});

test.each([false, true])(
  "canonical Current creation uses original Factory proof and denies late role revocation (%s)",
  async (revoke) => {
    await withOpenClawTestState({ label: "factory-current-checkout" }, async (state) => {
      vi.stubEnv("FACTORY_AUTH_MODE", "github");
      vi.stubEnv("GH_CONFIG_DIR", state.statePath("gh"));
      const registry = captureActivePluginRegistrySnapshot();
      const original = await createOriginalIssuerFixture(state, 91, "current grant");
      const connectedClients = new Set([original.client]);
      original.context.getClientConnIds = (filter) =>
        new Set(
          [...connectedClients]
            .filter((client) => !filter || filter(client))
            .flatMap((client) => (client.connId ? [client.connId] : [])),
        );
      const key = "agent:main:dashboard:factory-current-checkout";
      const url = "https://microsoft.ghe.com/acme/current-checkout.git";
      const external = installFactoryRestartRepositoryFixture({
        allowSessionCreate: true,
        binding: () => ({
          actorId: 700191,
          profileId: original.profile.id,
          agentId: "main",
          sessionKey: key,
          repositoryUrl: url,
          context: original.context,
        }),
        afterLookup: async () => {
          if (revoke) {
            await setCanonicalUserProfileRole(original.profile.id, "revoked");
          }
        },
        broker: () => "current",
      });
      try {
        await refreshPreparedModelRuntimeSnapshots(original.cfg, {
          gatewayLifecycle: true,
          catalogMode: "static",
        });
        const request = withEnvAsync(
          {
            OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
            OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: undefined,
          },
          async () =>
            await dispatchGatewayRequestInProcess<{
              ok: true;
              entry: { createdActor: unknown; repositoryWorkspaceId: string };
            }>(
              "sessions.create",
              { key, agentId: "main", repository: { url }, worktree: false },
              {
                client: original.client,
                context: original.context,
                methodRegistry: original.methods,
                hasCurrentClientAuthority: original.deviceSource.isCurrent,
                sessionMutationCommitGuard: original.original!.authority.assertCurrent,
              },
            ),
        );
        if (revoke) {
          await expect(request).rejects.toThrow();
          expect(external.proofs.size).toBe(1);
          expect(external.fetchFixture).not.toHaveBeenCalled();
          expect(
            await getSessionRepositoryWorkspaceStore().find({ agentId: "main", sessionKey: key }),
          ).toBeUndefined();
        } else {
          const created = await request;
          expect(created.ok).toBe(true);
          expect(created.entry.createdActor).toEqual({
            type: "human",
            source: "profile",
            id: original.profile.id,
          });
          const row = await getSessionRepositoryWorkspaceStore().get(
            created.entry.repositoryWorkspaceId,
          );
          expect(row).toMatchObject({
            sessionKey: key,
            url,
            requestedRef: "refs/heads/main",
            branch: "main",
            runSetupScript: false,
          });
          expect(external.proofs.size).toBeGreaterThan(0);
          expect(external.fetchFixture).toHaveBeenCalled();
          expect(JSON.stringify(row)).not.toContain("synthetic-restored-factory-token");
        }
      } finally {
        connectedClients.clear();
        original.original?.release();
        original.runtime.close();
        closeGatewayDeviceRevocation(original.context);
        await original.work.drain();
        external.native.mockRestore();
        restoreActivePluginRegistrySnapshot(registry);
      }
    });
  },
);

test("sessions.create carries Current default/selected and New checkout to isolated worker Git", async () => {
  const root = tempDirs.make("openclaw-session-repository-checkout-");
  const origin = path.join(root, "origin");
  const gatewayWorkspace = path.join(root, "must-not-be-created");
  await fs.mkdir(origin);
  const git = async (cwd: string, ...args: string[]) => {
    const result = await runCommandWithTimeout(["git", "-C", cwd, ...args], {
      timeoutMs: 10_000,
      baseEnv: {
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  await git(origin, "init", "--quiet", "--initial-branch=default-fixture");
  await fs.writeFile(path.join(origin, "result.txt"), "original default branch\n");
  await git(origin, "add", ".");
  await git(
    origin,
    "-c",
    "user.name=Repository Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "default",
  );
  const defaultCommit = await git(origin, "rev-parse", "HEAD");
  await git(origin, "checkout", "--quiet", "-b", "selected/branch");
  await fs.writeFile(path.join(origin, "result.txt"), "selected branch\n");
  await git(
    origin,
    "-c",
    "user.name=Repository Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-am",
    "selected",
  );
  const selectedCommit = await git(origin, "rev-parse", "HEAD");
  await git(origin, "checkout", "--quiet", "default-fixture");
  const url = "https://github.com/openclaw/openclaw.git";
  const tree = "a".repeat(40);
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input) => {
      const pathname = decodeURIComponent(new URL(new Request(input).url).pathname);
      if (pathname === "/repos/openclaw/openclaw") {
        return Response.json({
          node_id: "R_checkout_fixture",
          clone_url: url,
          private: false,
          default_branch: "default-fixture",
        });
      }
      if (pathname === "/repos/openclaw/openclaw/commits/heads/default-fixture") {
        return Response.json({ sha: defaultCommit, commit: { tree: { sha: tree } } });
      }
      if (pathname === "/repos/openclaw/openclaw/commits/heads/selected/branch") {
        return Response.json({ sha: selectedCommit, commit: { tree: { sha: tree } } });
      }
      if (pathname === `/repos/openclaw/openclaw/git/trees/${tree}`) {
        return Response.json({ sha: tree, truncated: false, tree: [] });
      }
      throw new Error("Unexpected checkout fixture metadata request");
    }),
  );
  testState.agentConfig = { workspace: gatewayWorkspace };
  const { storePath } = await createSessionStoreDir();
  const runtime = new NodeWorkerWorkspaceRuntime({
    root: path.join(root, "node-state"),
    env: { PATH: process.env.PATH, HOME: path.join(root, "node-home") },
  });
  const workerPaths = new Set<string>();
  for (const choice of [
    {
      worktree: false,
      ref: undefined,
      branch: "default-fixture",
      commit: defaultCommit,
      contents: "original default branch\n",
    },
    {
      worktree: false,
      ref: "selected/branch",
      branch: "selected/branch",
      commit: selectedCommit,
      contents: "selected branch\n",
    },
    {
      worktree: true,
      ref: "selected/branch",
      branch: undefined,
      commit: selectedCommit,
      contents: "selected branch\n",
    },
  ]) {
    vi.mocked(fetch).mockClear();
    // Only external metadata and Git transport are synthetic. Public creation,
    // SQLite ownership, node workspace isolation and Git branch binding run.
    const created = await withEnvAsync(
      {
        PATH: "",
        GH_CONFIG_DIR: root,
        GH_TOKEN: undefined,
        GITHUB_TOKEN: undefined,
        GH_ENTERPRISE_TOKEN: undefined,
        GITHUB_ENTERPRISE_TOKEN: undefined,
        OPENCLAW_GITHUB_IDENTITY_EXECUTABLE: undefined,
        FACTORY_AUTH_MODE: undefined,
        // The manual RPC harness disables plugins; repository metadata uses the
        // same prepared GitHub public surface as the adjacent read fixture.
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: undefined,
      },
      async () =>
        await directSessionReq<{
          key: string;
          entry: { sessionId: string; repositoryWorkspaceId: string };
        }>(
          "sessions.create",
          {
            agentId: "main",
            repository: { url, ...(choice.ref ? { ref: choice.ref } : {}) },
            worktree: choice.worktree,
          },
          controlUiClient,
        ),
    );
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    if (choice.worktree === false && choice.ref) {
      // Selected branches are verified during dispatch, not by a duplicate
      // network admission before session creation.
      expect(fetch).not.toHaveBeenCalled();
    }
    const { key, entry } = created.payload!;
    const saved = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
    expect(saved).not.toHaveProperty("worktree");
    expect(saved).not.toHaveProperty("spawnedCwd");
    const row = await getSessionRepositoryWorkspaceStore().get(entry.repositoryWorkspaceId);
    expect(row).toBeDefined();
    if (!row) {
      throw new Error("Created repository workspace is unavailable");
    }
    expect(row.branch).toBe(choice.branch ?? `openclaw/${row.workspaceId}`);
    if (choice.worktree === false && choice.ref) {
      const retry = await directSessionReq<{
        entry: { repositoryWorkspaceId: string };
      }>(
        "sessions.create",
        {
          key,
          agentId: "main",
          repository: { url, ref: choice.ref },
          worktree: false,
        },
        controlUiClient,
      );
      expect(retry.ok, JSON.stringify(retry.error)).toBe(true);
      expect(retry.payload?.entry.repositoryWorkspaceId).toBe(row.workspaceId);
      expect((await getSessionRepositoryWorkspaceStore().get(row.workspaceId))?.requestedRef).toBe(
        "refs/heads/selected/branch",
      );
    }
    const worker = createNodeWorkerRepositoryPreparation((command) =>
      runtime.exec({
        gatewayNamespace: "checkout-fixture",
        environmentId: "assigned-worker-fixture",
        sessionId: entry.sessionId,
        generation: 1,
        ...command,
        argv: [...command.argv],
      }),
    );
    const prepared = await worker.prepareRepository({
      origin: pathToFileURL(origin).href,
      ref: row.requestedRef ?? undefined,
      branch: row.branch,
    });
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") {
      throw new Error(prepared.reason);
    }
    expect(prepared.result.baseCommit).toBe(choice.commit);
    expect(await git(prepared.result.remoteWorkspaceDir, "branch", "--show-current")).toBe(
      row.branch,
    );
    expect(
      await fs.readFile(path.join(prepared.result.remoteWorkspaceDir, "result.txt"), "utf8"),
    ).toBe(choice.contents);
    workerPaths.add(prepared.result.remoteWorkspaceDir);
  }
  expect(workerPaths.size).toBe(3);
  expect(await fs.stat(gatewayWorkspace).catch(() => undefined)).toBeUndefined();
  expect(projectCloneMocks.materialize).not.toHaveBeenCalled();
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
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
      if (operation.type === "checkout.revision") {
        return "unchanged";
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
      const cacheLifetime = new AbortController();
      onTestFinished(() => cacheLifetime.abort());
      const params = { sessionKey: key, agentId: "main" };
      await loadControlUiSessionPullRequests(params, {
        cacheSignal: cacheLifetime.signal,
        fetchImpl,
      });
      const repositoryPins = getEventListeners(cacheLifetime.signal, "abort").length;
      expect(repositoryPins).toBeGreaterThan(0);
      await loadControlUiSessionPullRequests(params, {
        cacheSignal: cacheLifetime.signal,
        fetchImpl,
        resolveGitRoot: async () => workspace,
      });
      expect(getEventListeners(cacheLifetime.signal, "abort")).toHaveLength(repositoryPins);
      gitRead.mockClear();
      const preview = await loadControlUiSessionPullRequests(params, {
        cacheSignal: cacheLifetime.signal,
        fetchImpl,
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

test.each([
  { repository: { url: "file:///tmp/repository" } },
  { repository: { url: "https://token@github.com/openclaw/openclaw.git" } },
  {
    repository: { url: "https://github.com/openclaw/openclaw.git", ref: "--upload-pack=anything" },
  },
  { cwd: "/tmp/repository" },
  { execNode: "device" },
  { projectId: "workspace:main" },
  { projectGitUrl: "https://github.com/openclaw/openclaw.git" },
  { worktreeBaseRef: "main" },
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
