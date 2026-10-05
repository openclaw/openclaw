import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOriginalIssuerFixture } from "../../agents/main-session-recovery/main-session-recovery-original-issuer.test-support.js";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { setCanonicalUserProfileRole } from "../../state/user-profile-writes.js";
import { createGatewayWorkerPlacementReclaimBarriers } from "../server-worker-placement-reclaim.js";
import {
  createWorkerWorkspaceRecoveryPreparer,
  loadWorkerPlacementSessionRuntimeModule,
} from "../server-worker-placement-session-target.js";
import { createPlacementFailureActions } from "./placement-dispatch-failure.js";
import { recoverPendingWorkspaceResults } from "./placement-dispatch-pending-results.js";
import { createWorkerPlacementReclaim } from "./placement-reclaim.js";
import * as checkpoints from "./session-repository-checkpoints.js";
import { placements, sessionTarget, SESSION_ID } from "./worker-turn-launcher.test-support.js";
import * as resultGit from "./workspace-result-git.js";
import { useRepositoryWorkspaceResultFixture } from "./workspace-result-repository.test-support.js";
import { workerWorkspaceResultRef } from "./workspace-result-staging.js";

// The repository fixture has a local synthetic origin and no GitHub credentials.
vi.mock("./worker-github-binding.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./worker-github-binding.js")>()),
  prepareWorkerRepositoryGitHubIdentity: async () => ({
    token: undefined,
    selection: { source: "anonymous" },
    cacheScope: "anonymous",
    assertSelected: () => {},
    revalidate: async () => {},
    start: (operation: () => unknown) => Promise.resolve(operation()),
  }),
  prepareWorkerGitHubBindingGrant: async () => undefined,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("reclaim repository publication settlement", () => {
  const { fixture, readArtifact } = useRepositoryWorkspaceResultFixture();

  async function withReclaim(
    run: (
      f: Awaited<ReturnType<typeof fixture>>,
      stop: ReturnType<typeof createWorkerPlacementReclaim>,
      recover: () => Promise<Set<string>>,
      issuer: Awaited<ReturnType<typeof createOriginalIssuerFixture>>,
    ) => Promise<void>,
  ) {
    const f = await fixture("remote-exec");
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    const issuer = await createOriginalIssuerFixture(f.state, 0, "current grant");
    expectDefined(issuer.original, "verified original issuer");
    issuer.cfg.session = { ...issuer.cfg.session, store: sessionTarget.storePath };
    setRuntimeConfigSnapshot(issuer.cfg);
    const withPrepared = createWorkerWorkspaceRecoveryPreparer({
      loadSessionRuntime: loadWorkerPlacementSessionRuntimeModule,
      getConfig: () => issuer.cfg,
    });
    const withPreparedRecovery = withPrepared;
    const barriers = createGatewayWorkerPlacementReclaimBarriers({
      placements,
      loadSessionRuntime: loadWorkerPlacementSessionRuntimeModule,
      // No active model runs in this fixture; only the cancellation leaf is synthetic.
      cancelSessionWork: async ({ assertCurrent }) => assertCurrent(),
      revokeSessionAuthority: vi.fn(),
    });
    const stop = createWorkerPlacementReclaim({
      ...barriers,
      placements,
      environments: f.environments,
      workspaceOperations: f.workspaceOperations,
      withPreparedRecovery,
    });
    const recover = async () =>
      recoverPendingWorkspaceResults(
        {
          placements,
          environments: f.environments,
          failure: createPlacementFailureActions({ placements, environments: f.environments }),
          workspaceOperations: f.workspaceOperations,
          resolveWorkspace: f.resolveWorkspace,
          withPreparedRecovery,
        },
        await placements.readProjection([SESSION_ID], { current: true }),
      );
    try {
      await run(f, stop, recover, issuer);
    } finally {
      issuer.original!.release();
      issuer.deviceSource.release();
      issuer.runtime.close();
      await issuer.work.drain();
    }
  }

  it.each(["normal", "candidate cleanup"] as const)(
    "settles only its own published successor after %s",
    async (mode) => {
      await withReclaim(async (f, stop, _recover, issuer) => {
        if (mode === "candidate cleanup") {
          await fs.writeFile(path.join(f.remote, "kept.txt"), "accepted worker edit\n");
        }
        const before = expectDefined(await f.store.get(f.repository.workspaceId), "repository");
        const stage = vi.spyOn(checkpoints, "stageSessionRepositoryCheckpoint");
        if (mode === "candidate cleanup") {
          const update = resultGit.updateWorkspaceResultRefs;
          vi.spyOn(resultGit, "updateWorkspaceResultRefs").mockImplementation(async (...args) => {
            if (
              typeof args[1] !== "function" &&
              args[1].every((entry) => !entry.objectId) &&
              (await f.store.get(f.repository.workspaceId))?.revision === before.revision + 1
            ) {
              throw new Error("synthetic Git candidate cleanup failure after native commit");
            }
            return update(...args);
          });
        }
        const completed = await stop(sessionTarget, undefined, () =>
          issuer.original!.authority.assertCurrent(),
        );
        expect(completed.state).toBe("reclaimed");
        expect(stage).toHaveBeenCalledOnce();
        const after = expectDefined(await f.store.get(before.workspaceId), "accepted checkpoint");
        expect(after.revision).toBe(before.revision + 1);
        expect(after.baseCommit).toBe(before.baseCommit);
        if (mode === "candidate cleanup") {
          expect((await readArtifact(before.workspaceId, "kept.txt")).preview).toEqual(
            new Uint8Array(Buffer.from("accepted worker edit\n")),
          );
        } else {
          expect(after.manifestHash).toBe(before.manifestHash);
          expect(after.manifestHash).toBe(after.baseManifestHash);
        }
        expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
        expect(f.environments.destroy).toHaveBeenCalledOnce();
      });
    },
  );

  it.each([
    "foreign successor",
    "role revoked",
    "lost acknowledgement",
    "legacy reaccept",
    "foreign after admission",
    "newer bytes",
    "wrong branch",
    "node changed",
    "unknown environment",
    "held source",
    "retired actor",
    "session replaced",
  ] as const)(
    "preserves the published result after %s without repeating reconciliation",
    async (mode) => {
      await withReclaim(async (f, stop, recover, issuer) => {
        await fs.writeFile(path.join(f.remote, "kept.txt"), "accepted worker edit\n");
        const before = expectDefined(await f.store.get(f.repository.workspaceId), "repository");
        const stage = checkpoints.stageSessionRepositoryCheckpoint;
        vi.spyOn(checkpoints, "stageSessionRepositoryCheckpoint").mockImplementation(
          async (...args) => {
            const prepared = await stage(...args);
            return {
              ...prepared,
              publish: async () => {
                const accepted = await prepared.publish();
                if (mode === "foreign successor" || mode === "legacy reaccept") {
                  await f.store.acceptCheckpoint({
                    workspaceId: accepted.workspaceId,
                    expectedRevision: accepted.revision,
                    checkpointRef: prepared.checkpointRef,
                    manifestHash: expectDefined(accepted.manifestHash, "manifest"),
                    assertCurrent: () => issuer.original!.authority.assertCurrent(),
                  });
                  if (mode === "legacy reaccept") {
                    throw new Error(
                      "synthetic acknowledgement lost after identical prior reaccept",
                    );
                  }
                } else if (mode === "role revoked") {
                  await setCanonicalUserProfileRole(issuer.profile.id, "viewer");
                } else {
                  throw new Error("synthetic reply lost after known native checkpoint commit");
                }
                return accepted;
              },
            };
          },
        );
        const reconcile = vi.spyOn(f.tunnel, "reconcileWorkspace");
        await expect(
          stop(sessionTarget, undefined, () => issuer.original!.authority.assertCurrent()),
        ).rejects.toThrow();
        const pending = expectDefined(
          (await placements.listPendingWorkspaceResultsAsync())[0],
          "owned pending result",
        );
        expect(pending).toMatchObject({
          workspaceAcceptedAtMs: null,
          stagedResultRef: null,
          recoveryRequestedAtMs: null,
        });
        expect((await f.store.get(before.workspaceId))?.checkpointRef).toBe(
          workerWorkspaceResultRef(pending.claimId),
        );
        expect(f.environments.destroy).not.toHaveBeenCalled();
        expect(placements.get(SESSION_ID)?.state).toBe("draining");
        if (mode === "newer bytes") {
          await fs.writeFile(path.join(f.remote, "kept.txt"), "newer unaccepted bytes\n");
        } else if (mode === "wrong branch") {
          await resultGit.requireWorkspaceResultGit(f.remote, ["checkout", "-b", "foreign"]);
        } else if (mode === "unknown environment") {
          f.environments.get = () => undefined;
        } else if (mode === "retired actor") {
          await setCanonicalUserProfileRole(issuer.profile.id, "viewer");
          expect(() => issuer.original!.authority.assertCurrent()).toThrow();
        } else if (mode === "session replaced") {
          await upsertSessionEntryCore(sessionTarget, {
            sessionId: "replacement-session",
            lifecycleRevision: "replacement",
            updatedAt: Date.now(),
          });
        } else if (mode === "held source") {
          const environment = expectDefined(
            f.environments.get(pending.environmentId),
            "environment",
          );
          f.environments.get = () => ({
            ...environment,
            recoveryHold: {
              ...sessionTarget,
              profileId: environment.profileId,
              environmentId: pending.environmentId,
              ownerEpoch: pending.ownerEpoch,
              placementGeneration: pending.placementGeneration,
              leaseId: expectDefined(environment.leaseId, "lease"),
              phase: "requested",
              createdAtMs: Date.now(),
            },
          });
        } else if (mode === "foreign after admission" || mode === "node changed") {
          const read = checkpoints.readSessionRepositoryArtifacts;
          vi.spyOn(checkpoints, "readSessionRepositoryArtifacts").mockImplementation(
            async (...args) => {
              const artifact = await read(...args);
              if (mode === "foreign after admission") {
                const current = expectDefined(await f.store.get(before.workspaceId), "repository");
                await f.store.acceptCheckpoint({
                  workspaceId: current.workspaceId,
                  expectedRevision: current.revision,
                  checkpointRef: expectDefined(current.checkpointRef, "checkpoint"),
                  manifestHash: expectDefined(current.manifestHash, "manifest"),
                  assertCurrent: () => issuer.original!.authority.assertCurrent(),
                });
              } else {
                const environment = expectDefined(
                  f.environments.get(pending.environmentId),
                  "environment",
                );
                f.environments.get = () => ({ ...environment, nodeDeviceId: "replaced-node" });
              }
              return artifact;
            },
          );
        }
        if (mode !== "foreign successor" && mode !== "role revoked") {
          await recover();
        }
        expect(reconcile).toHaveBeenCalledOnce();
        if (
          mode === "lost acknowledgement" ||
          mode === "legacy reaccept" ||
          mode === "retired actor"
        ) {
          expect((await f.store.get(before.workspaceId))?.revision).toBe(
            before.revision + (mode === "legacy reaccept" ? 2 : 1),
          );
          expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
          expect(placements.get(SESSION_ID)?.state).toBe("reclaimed");
          expect(f.environments.destroy).toHaveBeenCalledOnce();
          if (mode === "retired actor") {
            expect(() => issuer.original!.authority.assertCurrent()).toThrow();
          }
        } else {
          expect(await placements.listPendingWorkspaceResultsAsync()).toHaveLength(1);
          expect(f.environments.destroy).not.toHaveBeenCalled();
        }
      });
    },
  );
});
