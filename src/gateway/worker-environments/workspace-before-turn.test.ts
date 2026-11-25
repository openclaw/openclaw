import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { requireGit } from "../../agents/worktrees/git.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import {
  WorkerTunnelOwnerDisconnectedError,
  type WorkerWorkspaceTunnelHandle,
} from "./tunnel-contract.js";
import {
  cleanupWorkerTurnLauncherTest,
  ENVIRONMENT_ID,
  OWNER_EPOCH,
  placements,
  root,
  seedActivePlacement,
  SESSION_ID,
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
  reconcileWorkspaceAfterTurn,
  recoverWorkspaceBeforeTurn,
} from "./workspace-result-finalize.js";
import { withStagedWorkerWorkspaceResult } from "./workspace-result-staging.js";

beforeEach(setupWorkerTurnLauncherTest);
afterEach(cleanupWorkerTurnLauncherTest);

async function fixture(quiescenceError?: Error) {
  const local = path.join(root, "gateway");
  const remote = path.join(root, "worker");
  await fs.mkdir(local);
  await fs.mkdir(remote);
  for (const directory of [local, remote]) {
    await fs.writeFile(path.join(directory, "prior.txt"), "base\n");
    await fs.writeFile(path.join(directory, "worker.txt"), "base\n");
  }
  await requireGit(local, ["init", "--quiet"]);
  await requireGit(local, ["add", "."]);
  await requireGit(local, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "--no-gpg-sign",
    "-m",
    "base",
  ]);
  const baseCommit = await requireGit(local, ["rev-parse", "HEAD"]);
  const capture = (directory: string) => captureWorkspaceManifest({ root: directory, baseCommit });
  const base = await capture(local);
  const manifests = new Map([[base.manifestRef, base.manifest]]);
  let failPublication = false;
  // The transport exchanges real snapshots and bytes; production reconciliation owns merging.
  const tunnel: WorkerWorkspaceTunnelHandle = {
    environmentId: ENVIRONMENT_ID,
    ownerEpoch: OWNER_EPOCH,
    runWorkspaceCommand: async () => {
      throw new Error("unexpected workspace command");
    },
    syncWorkspace: async () => {
      throw new Error("workspace is already synchronized");
    },
    stop: async () => {},
    quiesceWorkspace: async () => {
      if (quiescenceError) {
        throw quiescenceError;
      }
      return { assertActive: async () => {}, resume: async () => {} };
    },
    reconcileWorkspace: async (request) => {
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
    },
  };
  await seedActivePlacement("worker-turn", remote, base.manifestRef);
  const workspaceOperations = createWorkerWorkspaceOperationCoordinator();
  const claim = (id: string) =>
    placements.claimTurn({
      ...sessionTarget,
      owner: { kind: "worker", environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
      claimId: id,
      runId: id,
    });
  const execute = (turnClaim: WorkerSessionTurnClaim, before: boolean) => {
    const placement = placements.get(SESSION_ID);
    if (placement?.state !== "active") {
      throw new Error("expected active placement");
    }
    const input = turn(turnClaim.runId);
    return withWorkerTurnTranscriptDatabase(
      input,
      {
        assertCurrent() {},
        prepareAuthority: () => placements.prepareTurnClaimAuthority(turnClaim),
      },
      async () => {
        const params = {
          placement,
          placements,
          turnClaim,
          workspaceOperations,
          workspace: { kind: "local" as const, path: local },
        };
        if (before) {
          return recoverWorkspaceBeforeTurn({
            ...params,
            turn: input,
            tunnel,
          });
        }
        await placements.markWorkspaceResultPending(turnClaim);
        return reconcileWorkspaceAfterTurn({ ...params, tunnel, transcriptTarget: sessionTarget });
      },
    );
  };
  return {
    local,
    remote,
    claim,
    execute,
    interruptPublication() {
      failPublication = true;
    },
    async stage() {
      await fs.mkdir(path.join(local, "incoming"));
      await fs.writeFile(path.join(local, "incoming/file.txt"), "Gateway input\n");
      await fs.writeFile(path.join(local, "unselected.txt"), "Gateway only\n");
      await requireGit(local, ["add", "--", "incoming/file.txt"]);
    },
  };
}

it.each(["prior", "incoming"] as const)(
  "refreshes staged input before execution while preserving %s conflicts and tool admission",
  async (conflict) => {
    const f = await fixture();
    if (conflict === "prior") {
      await fs.writeFile(path.join(f.local, "prior.txt"), "Gateway conflict\n");
      await fs.writeFile(path.join(f.remote, "prior.txt"), "worker conflict\n");
    }
    await f.execute(await f.claim("previous-turn"), false);
    const previousConflict = placements.get(SESSION_ID)?.workspaceResultConflict;
    expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
    await f.stage();
    await fs.writeFile(path.join(f.remote, "worker.txt"), "independent worker edit\n");
    if (conflict === "incoming") {
      await fs.mkdir(path.join(f.remote, "incoming"));
      await fs.writeFile(path.join(f.remote, "incoming/file.txt"), "worker conflict\n");
    }
    const claim = await f.claim("next-turn");
    await placements.authorizeWorkerTurnTools(claim, ["exec"]);
    await f.execute(claim, true);
    expect(await fs.readFile(path.join(f.remote, "incoming/file.txt"), "utf8")).toBe(
      "Gateway input\n",
    );
    expect(await fs.readFile(path.join(f.remote, "worker.txt"), "utf8")).toBe(
      "independent worker edit\n",
    );
    await expect(fs.stat(path.join(f.remote, "unselected.txt"))).rejects.toMatchObject({
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
    await withStagedWorkerWorkspaceResult(
      { root: f.local, stagedResultRef: retained!.stagedResultRef },
      async ({ stagingRoot }) => {
        expect(await fs.readFile(path.join(stagingRoot, retained!.paths[0]!), "utf8")).toBe(
          "worker conflict\n",
        );
      },
    );
    await f.execute(claim, false);
    expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
    expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
  },
);

it("retains recovery custody when input publication fails before execution", async () => {
  const f = await fixture();
  await f.execute(await f.claim("previous-turn"), false);
  await f.stage();
  const claim = await f.claim("interrupted-input");
  f.interruptPublication();
  await expect(f.execute(claim, true)).rejects.toThrow("fixture publication interrupted");
  expect(placements.validateTurnClaim(claim)).toBe(true);
  const [pending] = await placements.listPendingWorkspaceResultsAsync();
  expect(pending).toMatchObject({ claimId: claim.claimId, workspaceAcceptedAtMs: null });
  expect(pending?.recoveryRequestedAtMs).toEqual(expect.any(Number));
  await expect(fs.stat(path.join(f.remote, "incoming/file.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("classifies an offline node during input refresh while retaining recovery custody", async () => {
  const f = await fixture(new WorkerTunnelOwnerDisconnectedError());
  const claim = await f.claim("offline-input");
  await expect(f.execute(claim, true)).rejects.toMatchObject({
    name: "WorkerRunnerUnavailableError",
    code: "runner-offline",
  });
  expect(placements.validateTurnClaim(claim)).toBe(true);
  const [pending] = await placements.listPendingWorkspaceResultsAsync();
  expect(pending).toMatchObject({ claimId: claim.claimId, workspaceAcceptedAtMs: null });
  expect(pending?.recoveryRequestedAtMs).toEqual(expect.any(Number));
});
