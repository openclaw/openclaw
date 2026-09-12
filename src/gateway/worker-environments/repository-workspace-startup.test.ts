import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseByPath } from "../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createNodeWorkerWorkspaceActions } from "./node-worker-workspace-actions.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { startNodeWorkspaceTransferTestServer } from "./node-workspace-transfer.test-support.js";
import { syncSessionRepositoryWorkspace } from "./repository-workspace-startup.js";
import {
  readSessionRepositoryCheckpoint,
  stageSessionRepositoryCheckpoint,
} from "./session-repository-checkpoints.js";
import type {
  WorkerTunnelHandle,
  WorkerWorkspaceReconcileRequest,
  WorkerWorkspaceSyncResult,
} from "./tunnel-contract.js";
import { prepareWorkerGitHubBinding } from "./worker-github-binding.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { readActualWorkspaceManifest } from "./workspace-reconcile-core.js";
import { requireWorkspaceResultGit } from "./workspace-result-git.js";

vi.mock("./worker-github-binding.js", () => ({ prepareWorkerGitHubBinding: vi.fn() }));

const session = {
  sessionId: "repository-session",
  sessionKey: "agent:main:repository-session",
  agentId: "main",
  generation: 3,
};
const gitAuthor = { name: "Repository Test", email: "repository@example.invalid" };
const token = "synthetic-repository-startup-token";
let state: OpenClawTestState | undefined;
let databasePath: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (databasePath) {
    closeOpenClawStateDatabaseByPath(databasePath);
  }
  await state?.cleanup();
  state = undefined;
  databasePath = undefined;
});

async function fixture(runSetupScript = false, preparedNode = false) {
  state = await createOpenClawTestState({
    label: "repository-startup",
    layout: "state-only",
    env: { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" },
  });
  const nodeHome = state.path("node-home");
  const remote = preparedNode
    ? path.join(
        nodeHome,
        ".openclaw-worker",
        "prepared",
        "gateway-prepared",
        "c".repeat(64),
        "workspace",
      )
    : state.path("worker-checkout");
  await fs.mkdir(remote, { recursive: true });
  await fs.writeFile(path.join(remote, "tracked.txt"), "pinned source\n");
  if (preparedNode) {
    await fs.mkdir(path.join(remote, ".openclaw"));
    await fs.writeFile(
      path.join(remote, ".openclaw", "worktree-setup.sh"),
      "#!/bin/sh\nexit 77\n",
      {
        mode: 0o755,
      },
    );
  }
  await requireWorkspaceResultGit(remote, ["init", "--quiet"]);
  await requireWorkspaceResultGit(remote, ["add", "."]);
  await requireWorkspaceResultGit(remote, [
    "-c",
    "user.name=Repository Test",
    "-c",
    "user.email=repository@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "source",
  ]);
  const baseCommit = await requireWorkspaceResultGit(remote, ["rev-parse", "HEAD"]);
  const base = await readActualWorkspaceManifest({ root: remote, baseCommit });
  const store = getSessionRepositoryWorkspaceStore();
  databasePath = store.path;
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw new Error("placement authority closed");
    }
  };
  const repository = store.create({
    ...session,
    url: "https://github.com/example/project.git",
    requestedRef: "refs/tags/v1.2.3",
    runSetupScript,
    assertCurrent,
  });
  vi.mocked(prepareWorkerGitHubBinding).mockReset().mockResolvedValue({
    token,
    login: "repository-bot",
    remoteUrl: repository.url,
    branch: repository.branch,
  });
  const syncWorkspace = vi.fn<WorkerTunnelHandle["syncWorkspace"]>(async (request) => {
    if (request.source.kind !== "repository") {
      throw new Error("Expected repository source");
    }
    if (request.source.runSetupScript) {
      await fs.writeFile(path.join(remote, "setup.txt"), "setup complete\n");
    }
    const manifest = await readActualWorkspaceManifest({ root: remote, baseCommit });
    return {
      mode: "repository",
      remoteWorkspaceDir: remote,
      baseCommit,
      baseManifestRef: base.manifestRef,
      manifestRef: manifest.manifestRef,
    };
  });
  const assertActive = vi.fn(async () => {});
  const resume = vi.fn(async () => {});
  const quiesceWorkspace = vi.fn(async () => ({ assertActive, resume }));
  const verifyStable = vi.fn(async () => {});
  type RepositorySource = Extract<
    WorkerWorkspaceReconcileRequest["source"],
    { kind: "repository" }
  >;
  const publish = vi.fn(
    async (prepared: Awaited<ReturnType<RepositorySource["prepareCheckpoint"]>>) => {
      await prepared.publish();
    },
  );
  const reconcileWorkspace = vi.fn<WorkerTunnelHandle["reconcileWorkspace"]>(async (request) => {
    if (request.source.kind !== "repository") {
      throw new Error("Expected repository checkpoint");
    }
    const manifest = await readActualWorkspaceManifest({ root: remote, baseCommit });
    const prepared = await request.source.prepareCheckpoint({
      stagingRoot: remote,
      baseManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
      currentManifestRaw: serializeWorkerWorkspaceManifest(manifest.manifest),
      baseManifestRef: base.manifestRef,
      currentManifestRef: manifest.manifestRef,
    });
    return {
      manifestRef: manifest.manifestRef,
      changed: manifest.manifestRef !== base.manifestRef,
      verifyStable,
      verifyLocalStable: () => prepared.verify(),
      publishStagedResult: () => publish(prepared),
      discardPreparedStagedResult: () => prepared.discard(),
    };
  });
  const tunnel: WorkerTunnelHandle = {
    environmentId: "repository-environment",
    ownerEpoch: 2,
    runWorkspaceCommand: vi.fn(),
    stop: vi.fn(),
    syncWorkspace,
    quiesceWorkspace,
    reconcileWorkspace,
  };
  const start = (extra: Partial<Parameters<typeof syncSessionRepositoryWorkspace>[0]> = {}) =>
    syncSessionRepositoryWorkspace({
      ...session,
      repository,
      tunnel,
      gitAuthor,
      assertCurrent,
      ...extra,
    });
  return {
    nodeHome,
    remote,
    store,
    repository,
    base,
    baseCommit,
    start,
    syncWorkspace,
    quiesceWorkspace,
    reconcileWorkspace,
    assertActive,
    resume,
    verifyStable,
    publish,
    closeAuthority: () => {
      current = false;
    },
  };
}

it("accepts the initial SQLite and bare Git checkpoint before sync can finish or resume the worker", async () => {
  const f = await fixture(true);
  const entered = createDeferredCore();
  const release = createDeferredCore();
  f.publish.mockImplementationOnce(async (prepared) => {
    entered.resolve();
    await release.promise;
    await prepared.publish();
  });
  f.resume.mockImplementationOnce(async () => {
    expect(f.store.get(f.repository.workspaceId)?.checkpointRef).toBeTruthy();
  });
  let finished = false;
  const pending = f.start({ runSetupScript: true }).then((result) => {
    finished = true;
    return result;
  });
  try {
    await Promise.race([entered.promise, pending]);
    expect(finished).toBe(false);
    expect(f.resume).not.toHaveBeenCalled();
    expect(f.store.get(f.repository.workspaceId)).toMatchObject({
      baseCommit: f.baseCommit,
      baseManifestHash: f.base.manifestRef,
      checkpointRef: null,
    });
  } finally {
    release.resolve();
    await pending;
  }
  const result = await pending;
  expect(prepareWorkerGitHubBinding).toHaveBeenCalledWith({
    sessionId: session.sessionId,
    sessionKey: session.sessionKey,
    agentId: session.agentId,
    assertCurrent: expect.any(Function),
  });
  expect(f.syncWorkspace).toHaveBeenCalledWith({
    sessionId: session.sessionId,
    sessionKey: session.sessionKey,
    generation: session.generation,
    gitAuthor,
    source: {
      kind: "repository",
      url: f.repository.url,
      ref: "refs/tags/v1.2.3",
      branch: f.repository.branch,
      baseCommit: undefined,
      gitToken: token,
      runSetupScript: true,
    },
  });
  closeOpenClawStateDatabaseByPath(f.store.path);
  const accepted = f.store.get(f.repository.workspaceId);
  expect(accepted).toMatchObject({ manifestHash: result.manifestRef });
  expect(accepted?.checkpointRef).toMatch(/^refs\/openclaw\/worker-results\//u);
  const snapshot = await readSessionRepositoryCheckpoint({ workspaceId: f.repository.workspaceId });
  expect(snapshot.changedEntries.map((entry) => entry.path)).toEqual(["setup.txt"]);
  expect((await snapshot.readEntry(snapshot.changedEntries[0]!)).toString()).toBe(
    "setup complete\n",
  );
  expect(
    await requireWorkspaceResultGit(f.store.artifactPath(f.repository.workspaceId), [
      "rev-parse",
      "--is-bare-repository",
    ]),
  ).toBe("true");
  expect(f.resume).toHaveBeenCalledOnce();
});

it("does not run setup when the repository did not request it", async () => {
  const f = await fixture(false);
  vi.mocked(prepareWorkerGitHubBinding).mockResolvedValue(undefined);
  await f.start({ runSetupScript: true });
  expect(f.syncWorkspace.mock.calls[0]?.[0].source).toMatchObject({ runSetupScript: false });
  expect(f.syncWorkspace.mock.calls[0]?.[0].source).not.toHaveProperty("gitToken");
  await expect(fs.stat(path.join(f.remote, "setup.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(f.store.get(f.repository.workspaceId)?.checkpointRef).toBeTruthy();
});

it("refuses requested setup without fresh authority instead of saving an incomplete initial state", async () => {
  const f = await fixture(true);
  await expect(f.start({ runSetupScript: undefined })).rejects.toThrow("administrator");
  expect(prepareWorkerGitHubBinding).not.toHaveBeenCalled();
  expect(f.syncWorkspace).not.toHaveBeenCalled();
  expect(f.store.get(f.repository.workspaceId)?.checkpointRef).toBeNull();
});

it("refuses interrupted setup recovery before credentials or worker commands are requested", async () => {
  const f = await fixture(true);
  await expect(f.start({ recovery: true, runSetupScript: true })).rejects.toThrow("administrator");
  expect(prepareWorkerGitHubBinding).not.toHaveBeenCalled();
  expect(f.syncWorkspace).not.toHaveBeenCalled();
  expect(f.store.get(f.repository.workspaceId)).toEqual(f.repository);
});

it("adopts completed setup, restores accepted repository edits, and retains the bound workspace on restart", async () => {
  const f = await fixture(true, true);
  await fs.writeFile(path.join(f.remote, "setup.txt"), "already prepared\n");
  const completed = await readActualWorkspaceManifest({ root: f.remote, baseCommit: f.baseCommit });
  const homeDir = path.join(path.dirname(f.remote), "home");
  const manifests = path.join(homeDir, ".openclaw-worker", "manifests");
  await fs.mkdir(manifests, { recursive: true });
  await fs.writeFile(
    path.join(manifests, `${f.base.manifestRef.slice(7)}.json`),
    serializeWorkerWorkspaceManifest(f.base.manifest),
  );
  await fs.writeFile(
    path.join(manifests, `${completed.manifestRef.slice(7)}.json`),
    serializeWorkerWorkspaceManifest(completed.manifest),
  );
  await requireWorkspaceResultGit(f.remote, ["checkout", "--detach", f.baseCommit]);
  await requireWorkspaceResultGit(f.remote, ["remote", "add", "origin", f.repository.url]);
  const env = {
    ...state!.env,
    HOME: f.nodeHome,
    OPENCLAW_STATE_DIR: path.join(f.nodeHome, "state"),
  };
  let runtime = new NodeWorkerWorkspaceRuntime({ env, ephemeral: true });
  const identity = {
    gatewayNamespace: "gateway-prepared",
    environmentId: "repository-environment",
    preparationKey: "a".repeat(64),
    cacheKey: "c".repeat(64),
  };
  await runtime.prepare({
    action: "register",
    ...identity,
    workspaceDir: f.remote,
    homeDir,
    sourceManifestRef: f.base.manifestRef,
    preparedManifestRef: completed.manifestRef,
  });
  await runtime.prepare({
    action: "bind",
    ...identity,
    sessionId: session.sessionId,
    sessionKey: session.sessionKey,
    ownerEpoch: session.generation,
  });
  const workspaceTransfer = createNodeWorkspaceTransferService({
    temporaryRoot: path.join(f.nodeHome, "transfers"),
    getOwner: () => ({
      credential: { ownerEpoch: session.generation, sessionId: session.sessionId },
      environment: {
        ownerEpoch: session.generation,
        attachedSessionIds: [session.sessionId],
        destroyRequestedAtMs: null,
        state: "attached",
      },
    }),
  });
  const server = await startNodeWorkspaceTransferTestServer(workspaceTransfer);
  const execute: Parameters<typeof createNodeWorkerWorkspaceActions>[0]["runWorkspaceCommand"] = (
    command,
  ) =>
    runtime.exec(
      {
        ...identity,
        sessionId: session.sessionId,
        sessionKey: command.sessionKey,
        generation: session.generation,
        argv: [...command.argv],
        input: command.input,
        timeoutMs: command.timeoutMs,
        resetWorkspace: command.resetWorkspace,
        seed: command.seed,
        transfer: command.transfer,
      },
      undefined,
      { url: server.gatewayUrl },
    );
  const actionOptions = {
    environmentId: identity.environmentId,
    ownerEpoch: session.generation,
    sessionId: session.sessionId,
    ownerSignal: new AbortController().signal,
    isOwnerCurrent: () => true,
    workspaceTransfer,
    runWorkspaceCommand: execute,
  };
  const actions = createNodeWorkerWorkspaceActions(actionOptions);
  f.syncWorkspace.mockImplementation(actions.syncWorkspace);
  const preparedRepository = {
    baseCommit: f.baseCommit,
    workspaceDir: f.remote,
    sourceManifestRef: f.base.manifestRef,
    preparedManifestRef: completed.manifestRef,
  };
  try {
    const initial = await f.start({ recovery: true, preparedRepository });
    expect(initial.manifestRef).toBe(completed.manifestRef);
    expect(await requireWorkspaceResultGit(f.remote, ["config", "--local", "user.name"])).toBe(
      gitAuthor.name,
    );
    expect(await requireWorkspaceResultGit(f.remote, ["config", "--local", "user.email"])).toBe(
      gitAuthor.email,
    );
    const initialCheckpoint = f.store.get(f.repository.workspaceId)!;
    await fs.writeFile(path.join(f.remote, "tracked.txt"), "accepted session edit\n");
    const edited = await readActualWorkspaceManifest({ root: f.remote, baseCommit: f.baseCommit });
    const checkpoint = await stageSessionRepositoryCheckpoint({
      workspaceId: f.repository.workspaceId,
      expectedRevision: initialCheckpoint.revision,
      assertCurrent: () => {},
      stagingRoot: f.remote,
      baseManifestRaw: serializeWorkerWorkspaceManifest(f.base.manifest),
      currentManifestRaw: serializeWorkerWorkspaceManifest(edited.manifest),
      baseManifestRef: f.base.manifestRef,
      currentManifestRef: edited.manifestRef,
    });
    await checkpoint.publish();
    const accepted = f.store.get(f.repository.workspaceId)!;
    await fs.writeFile(path.join(f.remote, "tracked.txt"), "unaccepted replacement bytes\n");
    const restored = await f.start({ repository: accepted, recovery: true, preparedRepository });
    expect(restored.manifestRef).toBe(edited.manifestRef);
    expect(await fs.readFile(path.join(f.remote, "tracked.txt"), "utf8")).toBe(
      "accepted session edit\n",
    );
    expect(f.store.get(f.repository.workspaceId)).toEqual(accepted);

    await fs.writeFile(path.join(f.remote, "unsaved.txt"), "keep across restart\n");
    closeOpenClawStateDatabaseByPath(resolveOpenClawStateSqlitePath(env));
    runtime = new NodeWorkerWorkspaceRuntime({ env, ephemeral: true });
    const restarted = createNodeWorkerWorkspaceActions({
      ...actionOptions,
      restoredWorkspace: {
        source: {
          kind: "repository",
          baseCommit: f.baseCommit,
          baseManifestRef: f.base.manifestRef,
        },
        manifestRef: restored.manifestRef,
        remoteWorkspaceDir: f.remote,
        sessionKey: session.sessionKey,
      },
    });
    await restarted.validateRestoredWorkspace();
    const result = await restarted.runWorkspaceCommand({
      argv: ["node", "-e", "process.stdout.write(require('node:fs').readFileSync('unsaved.txt'))"],
      transportRetry: "never",
    });
    expect(result).toMatchObject({ code: 0, stdout: "keep across restart\n" });
    expect(await requireWorkspaceResultGit(f.remote, ["symbolic-ref", "--short", "HEAD"])).toBe(
      f.repository.branch,
    );
  } finally {
    await server.close();
    await workspaceTransfer.closeAll();
    closeOpenClawStateDatabaseByPath(resolveOpenClawStateSqlitePath(env));
  }
  expect(f.syncWorkspace.mock.calls[0]?.[0].source).toMatchObject({
    prepared: preparedRepository,
    baseCommit: f.baseCommit,
    runSetupScript: false,
  });
  for (const [request] of f.syncWorkspace.mock.calls) {
    expect(request.source).not.toHaveProperty("gitToken");
  }
  expect(prepareWorkerGitHubBinding).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(f.remote, "setup.txt"), "utf8")).toBe("already prepared\n");
  expect(f.store.get(f.repository.workspaceId)).toMatchObject({
    baseCommit: f.baseCommit,
    baseManifestHash: f.base.manifestRef,
  });
  expect(f.store.get(f.repository.workspaceId)?.checkpointRef).toBeTruthy();
});

it.each(["commit", "source manifest"] as const)(
  "rejects a prepared %s different from the accepted session before acquiring credentials",
  async (change) => {
    const f = await fixture();
    await f.start();
    vi.mocked(prepareWorkerGitHubBinding).mockClear();
    f.syncWorkspace.mockClear();
    await expect(
      f.start({
        repository: f.store.get(f.repository.workspaceId)!,
        preparedRepository: {
          baseCommit: change === "commit" ? "f".repeat(40) : f.baseCommit,
          workspaceDir: f.remote,
          sourceManifestRef:
            change === "source manifest" ? `sha256:${"f".repeat(64)}` : f.base.manifestRef,
          preparedManifestRef: f.base.manifestRef,
        },
      }),
    ).rejects.toThrow(change === "commit" ? "pinned session commit" : "pinned source manifest");
    expect(prepareWorkerGitHubBinding).not.toHaveBeenCalled();
    expect(f.syncWorkspace).not.toHaveBeenCalled();
  },
);

it.each(["baseCommit", "baseManifestRef", "remoteWorkspaceDir"] as const)(
  "does not accept a prepared source when sync changes its attested %s",
  async (field) => {
    const f = await fixture();
    f.syncWorkspace.mockResolvedValueOnce({
      mode: "repository",
      baseCommit: f.baseCommit,
      baseManifestRef: f.base.manifestRef,
      remoteWorkspaceDir: f.remote,
      manifestRef: f.base.manifestRef,
      [field]: "different",
    });
    await expect(
      f.start({
        preparedRepository: {
          baseCommit: f.baseCommit,
          workspaceDir: f.remote,
          sourceManifestRef: f.base.manifestRef,
          preparedManifestRef: f.base.manifestRef,
        },
      }),
    ).rejects.toThrow("attested prepared workspace");
    expect(f.store.get(f.repository.workspaceId)).toEqual(f.repository);
    expect(f.reconcileWorkspace).not.toHaveBeenCalled();
  },
);

it.each(["identity", "sync", "verification"] as const)(
  "cannot accept startup state after authority closes during %s",
  async (phase) => {
    const f = await fixture();
    if (phase === "identity") {
      vi.mocked(prepareWorkerGitHubBinding).mockImplementationOnce(async () => {
        f.closeAuthority();
        return undefined;
      });
    } else if (phase === "sync") {
      const sync = f.syncWorkspace.getMockImplementation()!;
      f.syncWorkspace.mockImplementationOnce(async (request) => {
        const result = await sync(request);
        f.closeAuthority();
        return result;
      });
    } else {
      f.verifyStable.mockImplementationOnce(async () => {
        f.closeAuthority();
      });
    }
    await expect(f.start()).rejects.toThrow("placement authority closed");
    expect(f.store.get(f.repository.workspaceId)?.checkpointRef).toBeNull();
    if (phase === "identity") {
      expect(f.syncWorkspace).not.toHaveBeenCalled();
    }
    if (phase === "verification") {
      expect(f.resume).toHaveBeenCalledOnce();
    }
  },
);

it.each(["quiescence", "verification", "publication"] as const)(
  "discards the candidate and resumes the worker after %s fails",
  async (phase) => {
    const f = await fixture();
    const failure = new Error(`${phase} failed`);
    if (phase === "quiescence") {
      f.assertActive.mockRejectedValueOnce(failure);
    }
    if (phase === "verification") {
      f.verifyStable.mockRejectedValueOnce(failure);
    }
    if (phase === "publication") {
      f.publish.mockRejectedValueOnce(failure);
    }
    await expect(f.start()).rejects.toThrow(failure.message);
    expect(f.store.get(f.repository.workspaceId)?.checkpointRef).toBeNull();
    expect(
      await requireWorkspaceResultGit(f.store.artifactPath(f.repository.workspaceId), [
        "for-each-ref",
        "--format=%(refname)",
        "refs/openclaw/",
      ]),
    ).toBe("");
    expect(f.resume).toHaveBeenCalledOnce();
  },
);

it.each(["unchanged", "source commit", "base manifest", "accepted manifest"] as const)(
  "requires exact pinned state and preserves checkpoint ownership: %s",
  async (change) => {
    const f = await fixture(true);
    const initial = await f.start({ runSetupScript: true });
    const accepted = f.store.get(f.repository.workspaceId)!;
    f.quiesceWorkspace.mockClear();
    f.reconcileWorkspace.mockClear();
    const restored: WorkerWorkspaceSyncResult = {
      ...initial,
      ...(change === "source commit" ? { baseCommit: "f".repeat(40) } : {}),
      ...(change === "base manifest" ? { baseManifestRef: `sha256:${"f".repeat(64)}` } : {}),
      ...(change === "accepted manifest" ? { manifestRef: `sha256:${"f".repeat(64)}` } : {}),
    };
    f.syncWorkspace.mockImplementationOnce(async (request) => {
      expect(request.source).toMatchObject({
        kind: "repository",
        ref: "refs/tags/v1.2.3",
        baseCommit: f.baseCommit,
        branch: accepted.branch,
        runSetupScript: false,
      });
      if (request.source.kind !== "repository" || !request.source.checkpoint) {
        throw new Error("Accepted checkpoint was not sent to the replacement worker");
      }
      expect(
        await fs.readFile(path.join(request.source.checkpoint.stagingRoot, "setup.txt"), "utf8"),
      ).toBe("setup complete\n");
      return restored;
    });
    const pending = f.start({ repository: accepted, recovery: true, runSetupScript: true });
    if (change === "unchanged") {
      await expect(pending).resolves.toEqual(initial);
    } else {
      await expect(pending).rejects.toThrow(
        change === "accepted manifest" ? "accepted checkpoint" : "pinned source baseline",
      );
    }
    expect(f.store.get(accepted.workspaceId)).toEqual(accepted);
    expect(f.quiesceWorkspace).not.toHaveBeenCalled();
    expect(f.reconcileWorkspace).not.toHaveBeenCalled();
  },
);
