import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionWorktreeSourceChangedError } from "../../agents/worktrees/errors.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/io.js";
import { loadSessionEntry, patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import * as processExec from "../../process/exec.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { prepareUserProfileCatalogForTest } from "../../test-utils/user-profile-catalog.js";
import { INTERNAL_PROJECT_REQUESTER } from "../project-access.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { captureGatewayRequestOperatorGuard } from "../server-methods/session-mutation-guards.js";
import { createGatewaySession } from "../session-create-service.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { resolveSessionMutationAuthorizationAsync } from "../session-sharing-authorization-async.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { prepareSessionWorktreeCreation } from "../session-worktree-preparation.js";
import {
  forkSessionRepositoryWorkspace,
  readSessionRepositoryArtifacts,
  withSessionRepositoryCheckpoint,
} from "./session-repository-checkpoints.js";
import { placements, SESSION_ID, sessionTarget } from "./worker-turn-launcher.test-support.js";
import { requireWorkspaceResultGit as git } from "./workspace-result-git.js";
import { useRepositoryWorkspaceResultFixture } from "./workspace-result-repository.test-support.js";

// mock-isolation: Local repository origin; result custody, capture and stores are real.
vi.mock("./repository-github-identity.js", () => ({
  prepareRepositoryGitHubIdentity: async (_agentId: string, assertCurrent: () => void) => ({
    token: undefined,
    assertSelected: assertCurrent,
    start: async (start: () => Promise<unknown>) => await start(),
  }),
}));
afterEach(() => vi.restoreAllMocks());
const { fixture } = useRepositoryWorkspaceResultFixture();
const refs = (root: string) =>
  git(root, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/openclaw/"]);

it.each(["worker-turn", "remote-exec"] as const)(
  "%s settles its accepted disk turn without capturing a mirror",
  async (mode) => {
    const f = await fixture(mode);
    const mirrored = await f.resolveWorkspace();
    const bound = await f.bindDisk();
    const capture = vi.spyOn(f.tunnel, "reconcileWorkspace");
    const journal = vi.spyOn(placements, "beginWorkspaceReconciliation");
    const closeTools = vi.spyOn(placements, "closeWorkerTurnToolState");
    const owned = await f.beginTurn("disk-turn");
    await f.write("turn.txt", "disk turn bytes\n");
    const publish = vi.fn(async () => {
      expect(await placements.listPendingWorkspaceResultsAsync()).toMatchObject([
        { repositoryDiskAuthority: bound.diskAuthority, workspaceAcceptedAtMs: expect.any(Number) },
      ]);
      expect(placements.get(SESSION_ID)?.turnClaim).not.toBeNull();
    });
    const prepare = vi.fn(async () => {
      expect(placements.preparedWorkspaceResult(owned.turnClaim)?.workspaceAcceptedAtMs).toBeNull();
    });
    await f.finishTurn(owned, publish, {
      // A stale workspace read cannot reinterpret the accepted disk result as mirrored.
      workspace: mirrored,
      prepareAcceptedWorkspacePublication: prepare,
    });
    await f.expectSettled();
    expect(capture).not.toHaveBeenCalled();
    expect(journal).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
    expect(closeTools).toHaveBeenCalledTimes(mode === "worker-turn" ? 1 : 0);
    expect(await f.store.get(bound.workspaceId)).toEqual(bound);
    expect(await fs.readFile(path.join(f.remote, "turn.txt"), "utf8")).toBe("disk turn bytes\n");
  },
);

it("inherits fresh disk history and dirty files without sharing or releasing the active parent's disk", async () => {
  const f = await fixture("worker-turn");
  const repository = await f.bindDisk();
  const originalRefs = await refs(f.store.artifactPath(repository.workspaceId));
  const active = await f.beginTurn("parent-spawning");
  await f.write("private.txt", "committed on disk\n");
  await git(f.remote, ["add", "private.txt"]);
  await git(f.remote, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "private history",
  ]);
  const head = await git(f.remote, ["rev-parse", "HEAD"]);
  await f.write("dirty.txt", "staged parent bytes\n");
  await git(f.remote, ["add", "dirty.txt"]);
  await f.write("dirty.txt", "fresh disk bytes\n");
  const target = {
    agentId: sessionTarget.agentId,
    key: "agent:main:dashboard:disk-child",
    storePath: sessionTarget.storePath,
  };
  const prepared = await prepareSessionWorktreeCreation({
    cfg: getRuntimeConfig(),
    target,
    inheritParentKey: sessionTarget.sessionKey,
    projectRequester: INTERNAL_PROJECT_REQUESTER,
    repositoryMutations: f.mutations,
    deferWorktree: false,
    titleSource: "disk child",
    label: "disk child",
    useRequestedTitleSelection: false,
    runSetupScript: false,
    commitGuard() {},
    onTitleError() {},
    onTitleStateChanged() {},
  });
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) {
    throw new Error(prepared.error.message);
  }
  const child = (await f.store.get(prepared.value.repositoryWorkspaceId!))!;
  expect(child.workspaceId).not.toBe(repository.workspaceId);
  expect(child.diskAuthority).toBeUndefined();
  expect(child.branch).not.toBe(repository.branch);
  expect(await refs(f.store.artifactPath(repository.workspaceId))).toBe(originalRefs);
  expect(await f.store.get(repository.workspaceId)).toEqual(repository);
  expect(await git(f.remote, ["show", ":dirty.txt"])).toBe("staged parent bytes");
  expect(placements.get(SESSION_ID)?.turnClaim?.claimId).toBe(active.turnClaim.claimId);
  await f.write("dirty.txt", "parent changed later\n");
  await withSessionRepositoryCheckpoint({ workspaceId: child.workspaceId }, async (snapshot) => {
    expect(snapshot.gitHistory?.headCommit).toBe(head);
    expect(await fs.readFile(path.join(snapshot.stagingRoot, "dirty.txt"), "utf8")).toBe(
      "fresh disk bytes\n",
    );
  });
  await f.finishTurn(active);
  await f.expectSettled();
});

it.each(["capture", "read", "copy"] as const)(
  "rejects incomplete disk-child history at %s and removes the unexposed child",
  async (failure) => {
    const f = await fixture("worker-turn");
    const repository = await f.bindDisk();
    const artifact = f.store.artifactPath(repository.workspaceId);
    const originalRefs = await refs(artifact);
    await f.write("private.txt", "private commit bytes\n");
    await git(f.remote, ["add", "private.txt"]);
    await git(f.remote, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-m",
      "private history",
    ]);
    const head = await git(f.remote, ["rev-parse", "HEAD"]);
    const runExec = processExec.runExec;
    const spawnCommand = processExec.spawnCommand;
    let injected = false;
    vi.spyOn(processExec, "runExec").mockImplementation(async (command, args, options) => {
      if (
        command === "git" &&
        args.includes("hash-object") &&
        args.includes("--stdin") &&
        ((failure === "capture" && args.includes(artifact)) ||
          (failure === "copy" && !args.includes(artifact)))
      ) {
        injected = true;
        throw new Error("injected Git pack retention failure");
      }
      return await runExec(command, args, options);
    });
    vi.spyOn(processExec, "spawnCommand").mockImplementation((command, options) => {
      if (
        failure === "read" &&
        command.includes("cat-file") &&
        command.some((arg) => arg.endsWith(":history.pack"))
      ) {
        injected = true;
        throw new Error("injected Git pack extraction failure");
      }
      return spawnCommand(command, options);
    });
    const target = {
      agentId: sessionTarget.agentId,
      sessionKey: "agent:main:dashboard:incomplete-child",
    };
    await expect(
      f.mutations.fork({
        ...sessionTarget,
        repository,
        target,
        runSetupScript: false,
        assertCurrent() {},
      }),
    ).rejects.toThrow();
    expect(injected).toBe(true);
    expect(await f.store.find(target)).toBeUndefined();
    expect(await refs(artifact)).toBe(originalRefs);
    expect(await f.store.get(repository.workspaceId)).toEqual(repository);
    expect(await git(f.remote, ["rev-parse", "HEAD"])).toBe(head);
    expect(await fs.readFile(path.join(f.remote, "private.txt"), "utf8")).toBe(
      "private commit bytes\n",
    );
    // A fresh mutation proves the failed export released the workspace queue.
    await f.save("after-failure.txt", "parent remains writable\n");
    await f.expectSettled();
  },
);

it.each([
  { boundary: "checkpoint", change: "none" },
  { boundary: "checkpoint", change: "caller" },
  { boundary: "checkpoint", change: "source" },
  { boundary: "binding", change: "caller" },
  { boundary: "binding", change: "source" },
] as const)(
  "checks disk-child $change authority at final $boundary publication",
  async ({ boundary, change }) => {
    const f = await fixture("worker-turn");
    const repository = await f.bindDisk();
    const artifact = f.store.artifactPath(repository.workspaceId);
    const originalRefs = await refs(artifact);
    await f.write("dirty.txt", "current parent bytes\n");
    const cfg = rolePolicyConfig();
    const revokedRole = cfg.gateway?.roles?.definitions?.none;
    assert(revokedRole);
    revokedRole.scopes = ["operator.read"];
    cfg.session = { store: sessionTarget.storePath };
    setRuntimeConfigSnapshot(cfg);
    using cleanup = new DisposableStack();
    cleanup.defer((await prepareUserProfileCatalogForTest()).release);
    const client = roleClient("write", "disk-child-caller");
    const profileId = client.authenticatedUserProfile!.profileId;
    const key = "agent:main:dashboard:authorized-disk-child";
    const target = {
      agentId: sessionTarget.agentId,
      sessionKey: key,
      storePath: sessionTarget.storePath,
    };
    const context = createDirectChatContext({
      getRuntimeConfig: () => cfg,
      getCommittedRuntimeConfig: () => cfg,
    });
    const assertOperatorCurrent = captureGatewayRequestOperatorGuard({
      req: { type: "req", id: "disk-child", method: "sessions.create", params: { key } },
      client,
      context,
      isWebchatConnect: () => true,
      respond: vi.fn(),
    });
    const admitted = await resolveSessionMutationAuthorizationAsync({
      client,
      context,
      method: "sessions.create",
      requestParams: { key },
    });
    assert.equal(admitted.error, null);
    const authorization = admitted.authorization;
    assert(authorization);
    cleanup.defer(() => authorization.release?.());
    const assertCurrent = () => {
      assertOperatorCurrent();
      authorization.assertCurrent();
    };
    assertCurrent();
    let reachedBoundary = false;
    let childRoot: string | undefined;
    let publishedCheckpoints = 0;
    const changeAuthority = async () => {
      reachedBoundary = true;
      expect(loadSessionEntry(target)).toBeUndefined();
      if (change === "caller") {
        setUserProfileRole(profileId, "none");
        expect(assertCurrent).toThrow(SessionMutationAuthorizationChangedError);
      } else if (change === "source") {
        await patchSessionEntryCore(sessionTarget, () => ({ sessionId: "reassigned-parent" }), {
          skipMaintenance: true,
        });
      }
    };
    const run = processExec.runCommandWithTimeout;
    vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      if (
        argv.includes("update-ref") &&
        !argv.includes(artifact) &&
        typeof options !== "number" &&
        options.input?.toString().includes("create refs/openclaw/worker-results/")
      ) {
        childRoot = argv[argv.indexOf("-C") + 1];
        assert(childRoot);
        expect(await refs(childRoot)).not.toContain("refs/openclaw/worker-results/");
        if (boundary === "checkpoint") {
          await changeAuthority();
        }
        const result = await run(argv, options);
        if (result.termination === "exit" && result.code === 0) {
          publishedCheckpoints++;
        }
        return result;
      }
      return await run(argv, options);
    });
    const creating = createGatewaySession({
      cfg,
      key,
      commandSource: "test",
      requestingOperatorScopes: client.connect.scopes,
      requestingOperatorProfileId: profileId,
      operatorRoleActor: { kind: "operator", profileId },
      commitGuard: assertCurrent,
      bindSharingCreation: (operation) => authorization.bindCreation?.({ key }, operation),
      followSharingRegistration: authorization.followRegistration,
      prepareLifecycle: async (lifecycleTarget) => {
        const prepared = await prepareSessionWorktreeCreation({
          cfg,
          target: lifecycleTarget,
          inheritParentKey: sessionTarget.sessionKey,
          projectRequester: INTERNAL_PROJECT_REQUESTER,
          repositoryMutations: f.mutations,
          deferWorktree: false,
          titleSource: "disk child",
          label: "disk child",
          useRequestedTitleSelection: false,
          runSetupScript: false,
          commitGuard: assertCurrent,
          onTitleError() {},
          onTitleStateChanged() {},
        });
        assert(prepared.ok);
        if (boundary === "binding") {
          await changeAuthority();
        }
        return prepared;
      },
    });
    if (change === "none") {
      const created = await creating;
      assert(created.ok);
      const child = await f.store.find(target);
      assert(child);
      expect(loadSessionEntry(target)?.repositoryWorkspaceId).toBe(child.workspaceId);
      expect(child.diskAuthority).toBeUndefined();
      await withSessionRepositoryCheckpoint(
        { workspaceId: child.workspaceId },
        async (snapshot) => {
          expect(snapshot.gitHistoryNote).toBeUndefined();
          expect(await fs.readFile(path.join(snapshot.stagingRoot, "dirty.txt"), "utf8")).toBe(
            "current parent bytes\n",
          );
        },
      );
    } else {
      await expect(creating).rejects.toThrow(
        change === "caller"
          ? SessionMutationAuthorizationChangedError
          : SessionWorktreeSourceChangedError,
      );
      expect(await f.store.find(target)).toBeUndefined();
      expect(loadSessionEntry(target)).toBeUndefined();
      assert(childRoot);
      await expect(fs.stat(childRoot)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(reachedBoundary).toBe(true);
    expect(publishedCheckpoints).toBe(change === "none" || boundary === "binding" ? 1 : 0);
    expect(await refs(artifact)).toBe(originalRefs);
    expect(await f.store.get(repository.workspaceId)).toEqual(repository);
    expect(await fs.readFile(path.join(f.remote, "dirty.txt"), "utf8")).toBe(
      "current parent bytes\n",
    );
    await f.expectSettled();
  },
);

it("rolls back an unexposed disk child when resuming its parent fails", async () => {
  const f = await fixture("worker-turn");
  const repository = await f.bindDisk();
  const originalRefs = await refs(f.store.artifactPath(repository.workspaceId));
  await f.write("dirty.txt", "current bytes\n");
  const quiesce = f.tunnel.quiesceWorkspace.bind(f.tunnel);
  vi.spyOn(f.tunnel, "quiesceWorkspace").mockImplementation(async (...args) => {
    const held = await quiesce(...args);
    return {
      ...held,
      resume: async () => {
        await held.resume();
        throw new Error("resume reply lost");
      },
    };
  });
  const target = {
    agentId: sessionTarget.agentId,
    sessionKey: "agent:main:dashboard:failed-disk-child",
  };
  await expect(
    f.mutations.fork({
      ...sessionTarget,
      repository,
      target,
      runSetupScript: false,
      assertCurrent() {},
    }),
  ).rejects.toThrow("resume reply lost");
  expect(await f.store.find(target)).toBeUndefined();
  expect(await refs(f.store.artifactPath(repository.workspaceId))).toBe(originalRefs);
  expect(await f.store.get(repository.workspaceId)).toEqual(repository);
  expect(await fs.readFile(path.join(f.remote, "dirty.txt"), "utf8")).toBe("current bytes\n");
  await f.expectSettled();
});

it("refuses implicit checkpoints and forks after the original disk becomes authoritative", async () => {
  const f = await fixture("worker-turn");
  const repository = await f.bindDisk();
  await f.write("new-on-disk.txt", "not in the old mirror");
  const target = { agentId: repository.agentId, sessionKey: "agent:main:retained-fork" };
  await expect(
    forkSessionRepositoryWorkspace({
      ...target,
      sourceWorkspaceId: repository.workspaceId,
      assertCurrent() {},
    }),
  ).rejects.toThrow("fresh disk export");
  expect(await f.store.find(target)).toBeUndefined();
  await expect(
    readSessionRepositoryArtifacts({ workspaceId: repository.workspaceId, assertCurrent() {} }),
  ).rejects.toThrow("fresh disk export");
  expect(await f.store.get(repository.workspaceId)).toEqual(repository);
});
