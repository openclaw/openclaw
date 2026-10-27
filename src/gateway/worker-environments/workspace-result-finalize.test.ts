import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAgentUserMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { requireGit } from "../../agents/worktrees/git.js";
import {
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { runNodeWorkerWorkspaceTransfer } from "../../node-host/node-worker-transfer-client.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { loadWorkspaceSkills } from "../../skills/loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../../skills/loading/workspace-skill-prompt.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import type { NodeWorkerWorkspaceRetainEntry } from "../../worker/node-workspace-retain-protocol.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import { advancePlacementFixtureToActive } from "./placement-test-fixtures.js";
import {
  WorkerTunnelOwnerDisconnectedError,
  type WorkerWorkspaceTunnelHandle,
} from "./tunnel-contract.js";
import { WorkerWorkspaceReconciliationError } from "./worker-turn-failure.js";
import {
  ENVIRONMENT_ID,
  MANIFEST_REF,
  OWNER_EPOCH,
  SESSION_ID,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  database,
  placements,
  readWorkerTurnTranscriptStorageRows,
  reconcileUnchangedLocalWorkspace,
  root,
  seedActivePlacement,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
} from "./worker-turn-launcher.test-support.js";
import { withWorkerTurnTranscriptDatabase } from "./worker-turn-transcript-target.js";
import { prepareLocalWorkspaceReconciliation } from "./workspace-local-reconciliation.js";
import { captureWorkspaceManifest } from "./workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import {
  executeRemoteExecTurn as executeRemoteExecTurnCore,
  reconcileWorkspaceAfterTurn as reconcileWorkspaceAfterTurnCore,
  recoverWorkspaceBeforeTurn,
} from "./workspace-result-finalize.js";
import {
  withStagedWorkerWorkspaceResult,
  workerWorkspaceResultStaging,
} from "./workspace-result-staging.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "./workspace-sync-scripts.js";

function workspaceTunnel(
  overrides: Partial<WorkerWorkspaceTunnelHandle> = {},
): WorkerWorkspaceTunnelHandle {
  return {
    environmentId: ENVIRONMENT_ID,
    ownerEpoch: OWNER_EPOCH,
    runWorkspaceCommand: vi.fn(),
    quiesceWorkspace: async () => ({ assertActive: async () => {}, resume: async () => {} }),
    reconcileWorkspace: reconcileUnchangedLocalWorkspace,
    syncWorkspace: vi.fn(),
    stop: async () => {},
    ...overrides,
  };
}

async function initializeRepository(
  directory: string,
  git = (args: string[]) => requireGit(directory, args),
) {
  await git(["init", "--quiet"]);
  await git(["add", "."]);
  await git(["config", "user.name", "Fixture"]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  await git(["commit", "--quiet", "--allow-empty", "--no-gpg-sign", "-m", "base"]);
  const baseCommit = await git(["rev-parse", "HEAD"]);
  const capture = (source = directory) => captureWorkspaceManifest({ root: source, baseCommit });
  return { baseCommit, capture, base: await capture() };
}

function claimTurn(runId: string, kind: "local" | "worker") {
  return placements.claimTurn({
    ...sessionTarget,
    owner:
      kind === "local"
        ? { kind: "local", environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH }
        : { kind: "worker", environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
    claimId: runId,
    runId,
  });
}

const transcriptControls = (claim: WorkerSessionTurnClaim) => ({
  assertCurrent() {},
  prepareAuthority: () => placements.prepareTurnClaimAuthority(claim),
});

function reconcileWorkspaceAfterTurn(
  params: Parameters<typeof reconcileWorkspaceAfterTurnCore>[0],
) {
  return withWorkerTurnTranscriptDatabase(
    { ...params.transcriptTarget, sessionTarget: params.transcriptTarget },
    transcriptControls(params.turnClaim),
    (transcriptTarget) => reconcileWorkspaceAfterTurnCore({ ...params, transcriptTarget }),
  );
}

function recoverWorkspaceBeforeTurnInDatabase(
  params: Parameters<typeof recoverWorkspaceBeforeTurn>[0],
) {
  return withWorkerTurnTranscriptDatabase(params.turn, transcriptControls(params.turnClaim), () =>
    recoverWorkspaceBeforeTurn(params),
  );
}

async function activePlacement(remote?: string) {
  await seedActivePlacement("remote-exec", remote);
  const placement = placements.get(SESSION_ID);
  if (placement?.state !== "active") {
    throw new Error("expected active placement");
  }
  return placement;
}

async function beforeTurnFixture(
  quiesceWorkspace?: WorkerWorkspaceTunnelHandle["quiesceWorkspace"],
) {
  const local = path.join(root, "gateway");
  const remote = path.join(root, "worker");
  await Promise.all(
    [local, remote].map(async (directory) => {
      await fs.mkdir(directory);
      await fs.writeFile(path.join(directory, "prior.txt"), "base\n");
      await fs.writeFile(path.join(directory, "worker.txt"), "base\n");
    }),
  );
  const { capture, base } = await initializeRepository(local);
  const manifests = new Map([[base.manifestRef, base.manifest]]);
  let failPublication = false;
  const quiesce = vi.fn(
    quiesceWorkspace ?? (async () => ({ assertActive: async () => {}, resume: async () => {} })),
  );
  const reconcile = vi.fn(async (request) => {
    if (request.source.kind !== "local") {
      throw new Error("expected local source");
    }
    const previous = manifests.get(request.baseManifestRef);
    if (!previous) {
      throw new Error("missing accepted manifest");
    }
    const current = await capture(remote);
    let remoteRef = current.manifestRef;
    const accept = await prepareLocalWorkspaceReconciliation({
      request: { ...request.source, localPath: local, ...request },
      hashMemo: new Map(),
    });
    return accept({
      stagingRoot: remote,
      base: previous,
      current: current.manifest,
      baseRaw: serializeWorkerWorkspaceManifest(previous),
      currentRaw: serializeWorkerWorkspaceManifest(current.manifest),
      currentManifestRef: current.manifestRef,
      manifestRef: () => remoteRef,
      verifyStable: async () => {
        expect((await capture(remote)).manifestRef).toBe(remoteRef);
      },
      publishAcceptedManifest: async (accepted) => {
        if (failPublication) {
          throw new Error("fixture publication interrupted");
        }
        for (const entry of accepted.manifest.entries) {
          await fs.mkdir(path.dirname(path.join(remote, entry.path)), { recursive: true });
          await fs.copyFile(path.join(local, entry.path), path.join(remote, entry.path));
        }
        manifests.set(accepted.manifestRef, accepted.manifest);
        remoteRef = accepted.manifestRef;
      },
    });
  });
  const tunnel = workspaceTunnel({
    quiesceWorkspace: quiesce,
    reconcileWorkspace: reconcile,
  });
  await seedActivePlacement("worker-turn", remote, base.manifestRef);
  const workspaceOperations = createWorkerWorkspaceOperationCoordinator();
  const remotePath = (entry: string) => path.join(remote, entry);
  const claimWorker = (id: string) => claimTurn(id, "worker");
  const execute = async (claim: WorkerSessionTurnClaim, before: boolean, signal?: AbortSignal) => {
    const placement = placements.get(SESSION_ID);
    if (placement?.state !== "active") {
      throw new Error("expected active placement");
    }
    const input = turn(claim.runId);
    const params = {
      placement,
      placements,
      turnClaim: claim,
      workspaceOperations,
      workspace: { kind: "local" as const, path: local },
    };
    if (before) {
      return recoverWorkspaceBeforeTurnInDatabase({ ...params, turn: input, tunnel, signal });
    }
    await placements.markWorkspaceResultPending(claim);
    return reconcileWorkspaceAfterTurn({ ...params, tunnel, transcriptTarget: sessionTarget });
  };
  return {
    local,
    remotePath,
    readRemote: (entry: string) => fs.readFile(remotePath(entry), "utf8"),
    workspaceOperations,
    quiesce,
    reconcile,
    claim: claimWorker,
    execute,
    interruptPublication: () => {
      failPublication = true;
    },
    stage: async () => {
      await fs.mkdir(path.join(local, "incoming"));
      await fs.writeFile(path.join(local, "incoming/file.txt"), "Gateway input\n");
      await fs.writeFile(path.join(local, "unselected.txt"), "Gateway only\n");
      await requireGit(local, ["add", "--", "incoming/file.txt"]);
    },
  };
}

async function expectRecoveryRequested(claim: WorkerSessionTurnClaim) {
  expect(placements.validateTurnClaim(claim)).toBe(true);
  const [pending] = await placements.listPendingWorkspaceResultsAsync();
  expect(pending).toMatchObject({ claimId: claim.claimId, workspaceAcceptedAtMs: null });
  expect(pending?.recoveryRequestedAtMs).toEqual(expect.any(Number));
}

vi.mock("../../node-host/node-worker-transfer-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../node-host/node-worker-transfer-client.js")>()),
  runNodeWorkerWorkspaceTransfer: vi.fn(),
}));

beforeEach(setupWorkerTurnLauncherTest);
afterEach(cleanupWorkerTurnLauncherTest);

it.each(["prior", "incoming"] as const)(
  "refreshes staged input before execution while preserving %s conflicts and tool admission",
  async (conflict) => {
    const f = await beforeTurnFixture();
    if (conflict === "prior") {
      await fs.writeFile(path.join(f.local, "prior.txt"), "Gateway conflict\n");
      await fs.writeFile(f.remotePath("prior.txt"), "worker conflict\n");
    }
    await f.execute(await f.claim("previous-turn"), false);
    const previousConflict = placements.get(SESSION_ID)?.workspaceResultConflict;
    expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
    await f.stage();
    await fs.writeFile(f.remotePath("worker.txt"), "independent worker edit\n");
    if (conflict === "incoming") {
      await fs.mkdir(f.remotePath("incoming"));
      await fs.writeFile(f.remotePath("incoming/file.txt"), "worker conflict\n");
    }
    const claim = await f.claim("next-turn");
    await placements.authorizeWorkerTurnTools(claim, ["exec"]);
    await f.execute(claim, true);
    expect(await f.readRemote("incoming/file.txt")).toBe("Gateway input\n");
    expect(await f.readRemote("worker.txt")).toBe("independent worker edit\n");
    await expect(fs.stat(f.remotePath("unselected.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(placements.validateTurnClaim(claim)).toBe(true);
    expect(placements.isWorkerTurnToolAuthorized(claim, "exec")).toBe(true);
    expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
    const retained = placements.get(SESSION_ID)?.workspaceResultConflict;
    expect(retained?.paths).toEqual([conflict === "prior" ? "prior.txt" : "incoming/file.txt"]);
    if (conflict === "prior") {
      expect(retained).toEqual(previousConflict);
    }
    const conflictText = await withStagedWorkerWorkspaceResult(
      { root: f.local, stagedResultRef: retained!.stagedResultRef },
      ({ stagingRoot }) => fs.readFile(path.join(stagingRoot, retained!.paths[0]!), "utf8"),
    );
    expect(conflictText).toBe("worker conflict\n");
    await f.execute(claim, false);
    expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
    expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
  },
);

it("retains recovery custody when input publication fails before execution", async () => {
  const f = await beforeTurnFixture();
  await f.execute(await f.claim("previous-turn"), false);
  await f.stage();
  const claim = await f.claim("interrupted-input");
  f.interruptPublication();
  await expect(f.execute(claim, true)).rejects.toThrow("fixture publication interrupted");
  await expectRecoveryRequested(claim);
  await expect(fs.stat(f.remotePath("incoming/file.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("preserves an exact queued cancellation after handing recovery custody off", async () => {
  const f = await beforeTurnFixture();
  const blockerEntered = createDeferred();
  const releaseBlocker = createDeferred();
  const blocker = f.workspaceOperations.run(ENVIRONMENT_ID, async () => {
    blockerEntered.resolve();
    await releaseBlocker.promise;
  });
  await blockerEntered.promise;
  const queued = createDeferred();
  const run = f.workspaceOperations.run.bind(f.workspaceOperations);
  f.workspaceOperations.run = (...args) => {
    queued.resolve();
    return run(...args);
  };
  const claim = await f.claim("queued-input");
  const controller = new AbortController();
  const recovery = f.execute(claim, true, controller.signal);
  await awaitGateBeforeSettlement(queued.promise, recovery, "settled before queue");
  controller.abort(new DOMException("turn stopped", "AbortError"));
  await expect(recovery).rejects.toBe(controller.signal.reason);
  expect([f.quiesce.mock.calls.length, f.reconcile.mock.calls.length]).toEqual([0, 0]);
  await expectRecoveryRequested(claim);
  releaseBlocker.resolve();
  await Promise.all([blocker, f.workspaceOperations.run(ENVIRONMENT_ID, async () => {})]);
});

it("retains an entered workspace failure after cancellation until the mutation settles", async () => {
  const mutationEntered = createDeferred();
  const releaseMutation = createDeferred();
  const workspaceFailure = new Error("workspace transport failed");
  const f = await beforeTurnFixture(async () => {
    mutationEntered.resolve();
    await releaseMutation.promise;
    throw workspaceFailure;
  });
  const claim = await f.claim("entered-input");
  const controller = new AbortController();
  const recovery = f.execute(claim, true, controller.signal);
  await awaitGateBeforeSettlement(mutationEntered.promise, recovery, "settled before mutation");
  controller.abort();
  releaseMutation.resolve();
  await expect(recovery).rejects.toBeInstanceOf(WorkerWorkspaceReconciliationError);
  await expect(recovery).rejects.toMatchObject({
    cause: { name: "WorkerWorkspaceReconciliationError", cause: workspaceFailure },
  });
  expect([f.quiesce.mock.calls.length, f.reconcile.mock.calls.length]).toEqual([1, 0]);
  await expectRecoveryRequested(claim);
});

it("classifies an offline node during input refresh while retaining recovery custody", async () => {
  const f = await beforeTurnFixture(async () => {
    throw new WorkerTunnelOwnerDisconnectedError();
  });
  const claim = await f.claim("offline-input");
  await expect(f.execute(claim, true)).rejects.toMatchObject({
    name: "WorkerRunnerUnavailableError",
    code: "runner-offline",
  });
  await expectRecoveryRequested(claim);
});

it.each(
  (["prior", "report"] as const).flatMap((phase) =>
    (["current", "draining", "claim", "session"] as const).map((change) => ({ phase, change })),
  ),
)("revalidates $change settlement after $phase transcript hydration", async ({ phase, change }) => {
  const placement = await activePlacement();
  const source = SessionManager.open(sessionTarget);
  source.appendMessage(
    makeAgentUserMessage({ content: "Durable input 🦞\nunchanged", timestamp: 1 }),
  );
  const before = source.getPersistedEntries();
  const beforeRows = readWorkerTurnTranscriptStorageRows();
  const claim = await claimTurn(`hydrate-${phase}-${change}`, "local");
  await placements.markWorkspaceResultPending(claim);
  const entered = createDeferred();
  const release = createDeferred();
  const open = SessionManager.openAsync.bind(SessionManager);
  let reads = 0;
  const hydration = vi.spyOn(SessionManager, "openAsync").mockImplementation(async (...args) => {
    const manager = await open(...args);
    if (++reads === (phase === "prior" ? 1 : 2)) {
      entered.resolve();
      await release.promise;
    }
    return manager;
  });
  const publish = vi.fn();
  const quiesce = vi.fn(async () => ({ assertActive: async () => {}, resume: async () => {} }));
  const tunnel = workspaceTunnel({
    quiesceWorkspace: quiesce,
    reconcileWorkspace: async (request) => {
      if (request.source.kind !== "local" || !request.source.stagedResult) {
        throw new Error("expected local staged result");
      }
      await request.source.stagedResult.record(request.source.stagedResult.ref);
      return {
        ...(await reconcileUnchangedLocalWorkspace(request)),
        getAppliedWorkspaceResult: () => ({
          manifestRef: MANIFEST_REF,
          manifest: { version: 1, baseCommit: null, entries: [] },
          conflictPaths: ["src/retained.ts"],
          verifyLocalStable: async () => {},
        }),
      };
    },
  });
  const operation = reconcileWorkspaceAfterTurn({
    placement,
    placements,
    workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
    turnClaim: claim,
    workspace: { kind: "local", path: root },
    transcriptTarget: { ...sessionTarget },
    tunnel,
    publishAcceptedWorkspace: publish,
  }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  try {
    await awaitGateBeforeSettlement(entered.promise, operation, "settled before hydration");
    if (change === "draining") {
      await placements.startWorkspaceResultDrain(claim);
    } else if (change === "claim") {
      const pending = (await placements.listPendingWorkspaceResultsAsync(SESSION_ID))[0];
      if (!pending) {
        throw new Error("expected retained result");
      }
      await placements.failWorkspaceResultAndReleaseTurn(
        pending,
        new Error("fixture replaced result"),
      );
    } else if (change === "session") {
      await patchSessionEntryCore(sessionTarget, () => ({ sessionId: "replacement-session" }));
    }
    release.resolve();
    const outcome = await operation;
    if (change === "current" || change === "draining") {
      expect(outcome).toMatchObject({ value: { paths: ["src/retained.ts"] } });
      expect(publish).toHaveBeenCalledOnce();
      expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
      const after = SessionManager.open(sessionTarget).getPersistedEntries();
      expect(after.slice(0, before.length)).toEqual(before);
      expect(readWorkerTurnTranscriptStorageRows().slice(0, beforeRows.length)).toEqual(beforeRows);
      expect(after.at(-1)).toMatchObject({
        type: "custom_message",
        customType: "cloud-workspace-conflict",
      });
    } else {
      expect(outcome).toMatchObject({ error: expect.any(Error) });
      expect(publish).not.toHaveBeenCalled();
      if (phase === "prior") {
        expect(quiesce).not.toHaveBeenCalled();
      }
      if (change !== "session") {
        expect(SessionManager.open(sessionTarget).getPersistedEntries()).toEqual(before);
        expect(readWorkerTurnTranscriptStorageRows()).toEqual(beforeRows);
      }
    }
  } finally {
    release.resolve();
    await operation;
    hydration.mockRestore();
  }
});

it("reports cleanup failure and reclaims the inputs before the next turn without skills", async () => {
  const remote = path.join(await fs.realpath(root), "remote");
  const source = path.join(root, "source");
  await fs.mkdir(remote);
  await fs.mkdir(path.join(source, "skills", "synthetic"), { recursive: true });
  await fs.writeFile(
    path.join(source, "skills", "synthetic", "SKILL.md"),
    "---\ndescription: Synthetic resource\n---\n# Resource\n",
  );
  const placement = await activePlacement(remote);
  const inputTurn = {
    ...turn("cleanup-failure"),
    skillsSnapshot: await buildSkillSnapshot(source, {
      entries: loadWorkspaceSkills(source, { workspaceOnly: true }),
    }),
  };
  let failCleanup = true;
  const tunnel = workspaceTunnel({
    runWorkspaceCommand: async (command) => {
      if (JSON.parse(command.input!).op === "cleanup" && failCleanup) {
        failCleanup = false;
        return createCommandResult({ code: 1, stderr: "cleanup denied" });
      }
      return await runCommandWithTimeout([...command.argv], {
        cwd: remote,
        input: command.input,
        timeoutMs: 5_000,
      });
    },
  });
  const execute = async (
    input: Parameters<typeof executeRemoteExecTurnCore>[0]["turn"],
    runLocal: Parameters<typeof executeRemoteExecTurnCore>[0]["runLocal"],
  ) => {
    const turnClaim = await claimTurn(input.runId, "local");
    return withWorkerTurnTranscriptDatabase(
      input,
      {
        assertCurrent() {},
        prepareAuthority: () => placements.prepareTurnClaimAuthority(turnClaim),
      },
      () =>
        executeRemoteExecTurnCore({
          environments: { get: attachedEnvironment, startTunnel: async () => tunnel },
          onHandoff: () => {},
          placement,
          placements,
          workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
          turn: input,
          turnClaim,
          workspace: { kind: "local", path: root },
          runLocal,
        }),
    );
  };
  await expect(execute(inputTurn, async () => ({ meta: { durationMs: 1 } }))).rejects.toThrow(
    "Skill resource cleanup failed",
  );
  expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
  expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();

  expect(await fs.readdir(remote)).toHaveLength(1);
  const runLocal = vi.fn(async () => {
    expect(await fs.readdir(remote)).toEqual([]);
    return { meta: { durationMs: 1 } };
  });
  await execute(turn("cleanup-recovery"), runLocal);
  expect(runLocal).toHaveBeenCalled();
  expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
});

// Two worktrees cover concurrent publication; the upload barrier orders stale retention.
it.each([1, 2])(
  "reconciles %i completed turns when an older retention snapshot arrives after upload",
  async (count) => {
    const repository = path.join(root, "repository");
    const payload = path.join(root, "payload");
    await fs.mkdir(repository);
    await fs.mkdir(payload);
    const git = (cwd: string, ...args: string[]) => requireGit(cwd, args, { timeoutMs: 10_000 });
    const { baseCommit, base } = await initializeRepository(repository, (args) =>
      git(repository, ...args),
    );
    const bytes = Buffer.from("worker result\n\0binary\xff", "latin1");
    await fs.writeFile(path.join(payload, "result.bin"), bytes);
    const current = await captureWorkspaceManifest({ root: payload, baseCommit });
    const node = new NodeWorkerWorkspaceRuntime({ root: path.join(root, "node") });
    // Model HTTP delivery only; command serialization, manifest verification, retention,
    // claims, journals, and managed-worktree application all use their real owners.
    vi.mocked(runNodeWorkerWorkspaceTransfer).mockImplementation(async (input) => {
      await fs.mkdir(input.workspaceDir, { recursive: true });
      await git(input.workspaceDir, "init", "--quiet");
      await fs.copyFile(
        path.join(payload, "result.bin"),
        path.join(input.workspaceDir, "result.bin"),
      );
      const manifests = path.join(input.manifestHome, ".openclaw-worker", "manifests");
      await fs.mkdir(manifests, { recursive: true });
      for (const snapshot of [base, current]) {
        await fs.writeFile(
          path.join(manifests, `${snapshot.manifestRef.slice(7)}.json`),
          serializeWorkerWorkspaceManifest(snapshot.manifest),
        );
      }
      return current.manifestRef;
    });
    const retain: NodeWorkerWorkspaceRetainEntry[] = [];
    const retained = createDeferred();
    let uploadsRemaining = count;
    const workspaceOperations = createWorkerWorkspaceOperationCoordinator();
    const jobs = [];
    for (let index = 0; index < count; index++) {
      const sessionId = `session-${index}`;
      const environmentId = `environment-${index}`;
      const localWorkspaceDir = path.join(root, `worktree-${index}`);
      await git(repository, "worktree", "add", "--quiet", "--detach", localWorkspaceDir);
      const identity = { sessionId, sessionKey: `agent:main:${sessionId}`, agentId: "main" };
      const transcriptTarget = { ...sessionTarget, ...identity };
      await upsertSessionEntryCore(transcriptTarget, { sessionId, updatedAt: Date.now() });
      const placement = await advancePlacementFixtureToActive(placements, database, identity, {
        environmentId,
        ownerEpoch: 1,
        remoteWorkspaceDir: `/worker/${sessionId}`,
        workspaceBaseManifestRef: base.manifestRef,
        seedEnvironment: "before-dispatch",
      });
      const turnClaim = await placements.claimTurn({
        ...identity,
        owner: { kind: "worker", environmentId, ownerEpoch: 1 },
        claimId: `claim-${index}`,
        runId: `run-${index}`,
      });
      await placements.markWorkspaceResultPending(turnClaim);
      const nodeIdentity = {
        gatewayNamespace: "gateway-test",
        environmentId,
        sessionId,
        generation: 1,
      };
      retain.push({ environmentId, sessionId, generation: 1, manifestRefs: [base.manifestRef] });
      const tunnel = workspaceTunnel({
        environmentId,
        ownerEpoch: 1,
        runWorkspaceCommand: async () => {
          throw new Error("unexpected workspace command");
        },
        syncWorkspace: async () => {
          throw new Error("workspace already synced");
        },
        reconcileWorkspace: async (request) => {
          if (request.source.kind !== "local") {
            throw new Error("expected a local workspace source");
          }
          const uploaded = await node.exec(
            {
              ...nodeIdentity,
              argv: ["openclaw-internal-workspace-transfer"],
              transfer: {
                direction: "upload",
                token: "fixture-upload",
                baseManifestRef: base.manifestRef,
                referenceManifestRef: base.manifestRef,
              },
            },
            undefined,
            { url: "ws://gateway.invalid" },
          );
          if (--uploadsRemaining === 0) {
            try {
              await node.applyRetainSnapshot(
                {
                  version: 1,
                  gatewayNamespace: "gateway-test",
                  controllerId: "controller",
                  sequence: 1,
                  retain,
                },
                async () => [],
              );
              retained.resolve();
            } catch (error) {
              retained.reject(error);
            }
          }
          await retained.promise;
          const verifyStable = async () => {
            const captured = await node.exec({
              ...nodeIdentity,
              argv: [
                "node",
                "-e",
                REMOTE_WORKSPACE_MANIFEST_JS,
                uploaded.workspaceDir,
                baseCommit,
                "eligible",
                current.manifestRef.slice(7),
              ],
            });
            if (captured.code !== 0) {
              throw new Error(captured.stderr);
            }
            expect(captured.stdout.trim()).toBe(current.manifestRef);
          };
          await verifyStable();
          return {
            ...(await workerWorkspaceResultStaging.prepareRequestedWorkerWorkspaceResult({
              request: {
                ...request.source,
                localPath: request.source.path,
                remoteWorkspaceDir: request.remoteWorkspaceDir,
                baseManifestRef: request.baseManifestRef,
              },
              stagingRoot: payload,
              currentManifestRef: current.manifestRef,
              baseManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
              currentManifestRaw: serializeWorkerWorkspaceManifest(current.manifest),
            })),
            manifestRef: current.manifestRef,
            changed: true,
            verifyStable,
          };
        },
      });
      jobs.push({
        placement,
        turnClaim,
        tunnel,
        workspace: { kind: "local" as const, path: localWorkspaceDir },
        transcriptTarget,
      });
    }
    const outcomes = await Promise.allSettled(
      jobs.map((job) =>
        reconcileWorkspaceAfterTurn({
          ...job,
          placements,
          workspaceOperations,
        }),
      ),
    );
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toBeUndefined();
    expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
    for (const job of jobs) {
      expect(await fs.readFile(path.join(job.workspace.path, "result.bin"))).toEqual(bytes);
      expect(placements.get(job.placement.sessionId)?.turnClaim).toBeNull();
    }
  },
);
