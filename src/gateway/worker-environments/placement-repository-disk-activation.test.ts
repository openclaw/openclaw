import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { resolveSessionStorePathForScope } from "../../config/sessions/session-store-path.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createWorkerPlacementIdleSweep } from "./placement-idle-sweep.js";
import {
  ORIGINAL_RESOURCE,
  RETAINED_SELECTOR,
  repositoryActivationFixture,
  configureRepositoryDurability,
} from "./placement-repository-disk-activation.test-support.js";
import * as support from "./service.test-support.js";
import { readSessionRepositoryArtifacts } from "./session-repository-checkpoints.js";
import { withWorkerTurnTranscriptDatabase } from "./worker-turn-transcript-target.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import { reconcileWorkspaceAfterTurn } from "./workspace-result-finalize.js";
import { requireWorkspaceResultGit } from "./workspace-result-git.js";

// mock-isolation: Local Git source has no remote account; do not discover host credentials.
vi.mock("./repository-github-identity.js", () => ({ prepareRepositoryGitHubIdentity: vi.fn() }));

describe("configured repository disk activation", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each([undefined, { mode: "mirrored" } as const])(
    "keeps the mirrored sibling when workspace durability is %j",
    async (workspaceDurability) => {
      const f = await repositoryActivationFixture({ workspaceDurability });
      const active = await f.dispatch();
      const repository = (await f.repositories.get(f.repository.workspaceId))!;
      expect(active.state).toBe("active");
      expect(repository.diskAuthority).toBeUndefined();
      expect(repository.checkpointRef).toMatch(/^refs\/openclaw\/worker-results\//);
      expect(repository.manifestHash).toBe(active.workspaceBaseManifestRef);
      expect(support.testState.store.get(active.environmentId)?.retention).toBeNull();
      expect(f.acquisition).toHaveLength(1);
      expect(f.acquisition[0]?.requested?.retention).toBeUndefined();
      expect(f.acquisition[0]?.persisted?.retention).toBeNull();
      expect(await fs.readFile(path.join(active.remoteWorkspaceDir, "tracked.txt"), "utf8")).toBe(
        "pinned source\n",
      );
      const checkpoint = await readSessionRepositoryArtifacts({
        workspaceId: repository.workspaceId,
        assertCurrent() {},
      });
      expect(checkpoint.currentManifestRef).toBe(active.workspaceBaseManifestRef);
      expect(f.tunnel.syncWorkspace).toHaveBeenCalledOnce();
      expect(f.tunnel.reconcileWorkspace).toHaveBeenCalledOnce();
      expect(await f.placements.listPendingWorkspaceResultsAsync()).toEqual([]);
    },
  );

  it("commits selected retention before allocation, hydrates the accepted source once, and binds the original disk at activation", async () => {
    const f = await repositoryActivationFixture({
      workspaceDurability: RETAINED_SELECTOR,
      acceptedCheckpoint: true,
    });
    const reserveLookup = vi.spyOn(f.harness.environments, "getPreparedCandidates");
    const active = await f.dispatch();
    expect(reserveLookup).not.toHaveBeenCalled();
    expect(f.provision).toHaveBeenCalledOnce();
    expect(f.acquisition).toHaveLength(1);
    const acquired = f.acquisition[0]!;
    const policy = acquired.persisted?.retention?.policy;
    expect(policy).toEqual({
      version: 1,
      ownerBinding: expect.any(String),
      computeWindowSeconds: 600,
    });
    expect(acquired.persisted).toMatchObject({
      state: "provisioning",
      environmentId: active.environmentId,
      resourceReceipt: null,
    });
    expect(acquired.requested?.retention).toEqual(policy);
    expect(active.state).toBe("active");
    expect(await f.placements.getAsync(REQUEST.sessionId)).toMatchObject({
      state: "active",
      environmentId: active.environmentId,
      activeOwnerEpoch: active.activeOwnerEpoch,
    });
    const repository = (await f.repositories.get(f.repository.workspaceId))!;
    expect(repository).toMatchObject({
      baseCommit: f.baseCommit,
      checkpointRef: f.repository.checkpointRef,
      manifestHash: f.repository.manifestHash,
      diskAuthority: { environmentId: active.environmentId, resourceReceipt: ORIGINAL_RESOURCE },
    });
    expect(support.testState.store.get(active.environmentId)).toMatchObject({
      state: "attached",
      resourceReceipt: ORIGINAL_RESOURCE,
      retention: { policy },
      lastActivatedAtMs: support.testState.nowMs,
    });
    expect(
      await requireWorkspaceResultGit(active.remoteWorkspaceDir, ["branch", "--show-current"]),
    ).toBe(f.repository.branch);
    expect(await fs.readFile(path.join(active.remoteWorkspaceDir, "session.txt"), "utf8")).toBe(
      "accepted before disk activation\n",
    );
    expect(f.tunnel.syncWorkspace).toHaveBeenCalledOnce();
    expect(f.tunnel.reconcileWorkspace).not.toHaveBeenCalled();
    expect(await f.placements.listPendingWorkspaceResultsAsync()).toEqual([]);

    const target = { ...REQUEST, storePath: resolveSessionStorePathForScope(REQUEST) };
    await upsertSessionEntryCore(target, {
      sessionId: REQUEST.sessionId,
      repositoryWorkspaceId: repository.workspaceId,
    });
    const turnClaim = await f.placements.claimTurn({
      ...REQUEST,
      claimId: "configured-disk-turn",
      runId: "configured-disk-turn",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    await f.placements.markWorkspaceResultPending(turnClaim);
    expect(await f.placements.listPendingWorkspaceResultsAsync()).toMatchObject([
      {
        repositoryWorkspaceId: repository.workspaceId,
        repositoryDiskAuthority: repository.diskAuthority,
      },
    ]);
    await fs.writeFile(path.join(active.remoteWorkspaceDir, "turn.txt"), "only on retained disk");
    const journal = vi.spyOn(f.placements, "beginWorkspaceReconciliation");
    await withWorkerTurnTranscriptDatabase(
      { ...target, sessionTarget: target },
      {
        assertCurrent() {},
        prepareAuthority: () => f.placements.prepareTurnClaimAuthority(turnClaim),
      },
      (transcriptTarget) =>
        reconcileWorkspaceAfterTurn({
          placement: active,
          placements: f.placements,
          turnClaim,
          workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
          workspace: { kind: "repository", repository },
          transcriptTarget,
          tunnel: f.tunnel,
        }),
    );
    expect(f.tunnel.reconcileWorkspace).not.toHaveBeenCalled();
    expect(journal).not.toHaveBeenCalled();
    expect(await f.repositories.get(repository.workspaceId)).toEqual(repository);
    expect(await f.placements.listPendingWorkspaceResultsAsync()).toEqual([]);
    expect(f.placements.get(REQUEST.sessionId)?.turnClaim).toBeNull();
    expect(await fs.readFile(path.join(active.remoteWorkspaceDir, "turn.txt"), "utf8")).toBe(
      "only on retained disk",
    );
    await expect(f.harness.service.reclaim(REQUEST)).rejects.toThrow(
      "Move to Gateway before retirement",
    );
    await expect(
      f.placements.beginPlacementMove({
        sessionId: REQUEST.sessionId,
        source: {
          generation: active.generation,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
        target: { kind: "profile", profileId: "another-profile" },
      }),
    ).rejects.toThrow("Move to Gateway before retirement");
    expect(f.placements.get(REQUEST.sessionId)).toMatchObject({
      state: "active",
      generation: active.generation,
    });
    expect(await f.placements.getPlacementMoveAsync(REQUEST.sessionId)).toBeUndefined();
    const reclaim = vi.fn(async () => {
      throw new Error("retained disk entered legacy idle reclaim");
    });
    const warn = vi.fn();
    using clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(support.testState.nowMs + 60_001);
    await createWorkerPlacementIdleSweep({
      placements: f.placements,
      environments: f.harness.environments,
      dispatch: { reclaim },
      getConfig: () => ({
        cloudWorkers: { profiles: { development: { provider: "fake", suspendAfter: "1m" } } },
      }),
      reportChanges: (run) => run(),
      info() {},
      warn,
    }).sweep();
    expect(reclaim).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    clock.mockRestore();
    expect(await f.repositories.get(repository.workspaceId)).toEqual(repository);
  });

  it("refuses a provider without retained lifecycle capability before allocation", async () => {
    const f = await repositoryActivationFixture({
      workspaceDurability: RETAINED_SELECTOR,
      unsupported: true,
    });
    await expect(f.dispatch()).rejects.toThrow(/retain|capabilit|support/i);
    expect(f.provision).not.toHaveBeenCalled();
    expect(await f.repositories.get(f.repository.workspaceId)).toEqual(f.repository);
  });

  it("does not overwrite a mirrored pending result when retained disk is selected", async () => {
    const f = await repositoryActivationFixture();
    const active = await f.dispatch();
    const claim = await f.placements.claimTurn({
      ...REQUEST,
      claimId: "unaccepted-mirrored-turn",
      runId: "unaccepted-mirrored-turn",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    await f.placements.markWorkspaceResultPending(claim);
    const pending = await f.placements.listPendingWorkspaceResultsAsync();
    const owned = f.placements.get(REQUEST.sessionId);
    const repository = await f.repositories.get(f.repository.workspaceId);
    expect(pending).toHaveLength(1);
    configureRepositoryDurability(RETAINED_SELECTOR);
    await expect(f.dispatch()).rejects.toThrow(/active|pending|recovery|dispatch/i);
    expect(await f.placements.listPendingWorkspaceResultsAsync()).toEqual(pending);
    expect(await f.repositories.get(f.repository.workspaceId)).toEqual(repository);
    expect(f.placements.get(REQUEST.sessionId)).toEqual(owned);
    expect(f.provision).toHaveBeenCalledOnce();
    expect(f.tunnel.syncWorkspace).toHaveBeenCalledOnce();
  });

  it.each(["missing", "replaced"] as const)(
    "does not activate, bind, or allocate a replacement for a %s resource receipt",
    async (receipt) => {
      const f = await repositoryActivationFixture({
        workspaceDurability: RETAINED_SELECTOR,
        receipt,
      });
      await expect(f.dispatch()).rejects.toThrow(/receipt|resource|identity/i);
      expect(f.provision).toHaveBeenCalledOnce();
      expect(support.testState.store.list()).toHaveLength(1);
      expect(support.testState.store.list()[0]?.lastActivatedAtMs).toBeNull();
      expect(f.placements.get(REQUEST.sessionId)?.state).not.toBe("active");
      expect(await f.repositories.get(f.repository.workspaceId)).toEqual(f.repository);
      expect(await f.placements.listPendingWorkspaceResultsAsync()).toEqual([]);
    },
  );

  it.each(["disk-binding", "activation"] as const)(
    "rolls back both native activation facts when the %s write fails",
    async (failure) => {
      const f = await repositoryActivationFixture({
        workspaceDurability: RETAINED_SELECTOR,
        acceptedCheckpoint: true,
      });
      // Test-only native SQL fault injection. Either ordering of two separate commits is caught:
      // binding refusal must roll back activation; activation refusal must roll back binding.
      const target =
        failure === "disk-binding"
          ? "disk_authority_json ON session_repository_workspaces WHEN NEW.disk_authority_json IS NOT NULL"
          : "last_activated_at_ms ON worker_environments WHEN NEW.last_activated_at_ms IS NOT NULL";
      support.testState.stateDb.db.exec(
        "CREATE TRIGGER refuse_disk_activation BEFORE UPDATE OF " +
          target +
          " BEGIN SELECT RAISE(ABORT, 'fixture activation commit refused'); END;",
      );
      try {
        await expect(f.dispatch()).rejects.toThrow("fixture activation commit refused");
        expect(f.provision).toHaveBeenCalledOnce();
        expect(f.tunnel.syncWorkspace).toHaveBeenCalledOnce();
        expect(await f.repositories.get(f.repository.workspaceId)).toEqual(f.repository);
        expect(support.testState.store.list()[0]?.lastActivatedAtMs).toBeNull();
        expect(f.placements.get(REQUEST.sessionId)?.state).not.toBe("active");
        expect(await f.placements.listPendingWorkspaceResultsAsync()).toEqual([]);
      } finally {
        support.testState.stateDb.db.exec("DROP TRIGGER refuse_disk_activation");
      }
    },
  );
});
