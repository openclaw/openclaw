import { afterEach, assert, describe, expect, it, vi } from "vitest";
import type { WorkerResourceReceipt } from "../../plugins/capability-provider.types.js";
import { createSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { makeClaimInput } from "./placement-lifecycle.test-support.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import * as support from "./service.test-support.js";
import { createWorkerEnvironmentStore } from "./store.js";

const assertCurrent = () => {};

describe("repository disk authority and pending-result recovery", () => {
  support.setupWorkerEnvironmentServiceSuite();
  afterEach(() => vi.unstubAllEnvs());

  async function fixture() {
    vi.stubEnv("OPENCLAW_STATE_DIR", support.testState.root);
    const database = support.testState.stateDb;
    const placements = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
    const repositories = createSessionRepositoryWorkspaceStore({ path: database.path });
    const created = await repositories.create({
      ...REQUEST,
      url: "https://example.invalid/repository.git",
      assertCurrent,
    });
    const repository = await repositories.bindBase({
      workspaceId: created.workspaceId,
      expectedRevision: created.revision,
      baseCommit: "a".repeat(40),
      baseManifestHash: "sha256:" + "b".repeat(64),
      assertCurrent,
    });
    const resolveWorkspace = async () => ({
      kind: "repository" as const,
      repository: (await repositories.get(repository.workspaceId))!,
    });
    const harness = await createHarness(database, placements, { resolveWorkspace });
    const active = await harness.placements.seedActive(2);
    assert(active.state === "active");
    harness.markEnvironmentNodeDeviceId("repository-node");
    const environments = await createWorkerEnvironmentStore({ database });
    const environment = environments.get(active.environmentId)!;
    assert(environment.leaseId);
    const receipt: WorkerResourceReceipt = {
      version: 1,
      leaseId: environment.leaseId,
      identity: { machineId: "original-machine", diskId: "original-disk" },
    };
    await environments.recordResourceReceipt({
      environmentId: environment.environmentId,
      provisionOperationId: environment.provisionOperationId,
      receipt,
      assertCurrent,
    });
    vi.spyOn(harness.environments, "reclaim");
    const project = vi.mocked(harness.environments.get).getMockImplementation()!;
    const get = vi.spyOn(harness.environments, "get").mockImplementation((id) => {
      const row = environments.get(id);
      const service = project(id);
      return row && service ? { ...service, ...row } : undefined;
    });
    const authority = { environmentId: active.environmentId, resourceReceipt: receipt };
    const bind = () =>
      repositories.bindDisk({
        workspaceId: repository.workspaceId,
        expectedRevision: repository.revision,
        diskAuthority: authority,
        assertCurrent,
      });
    return {
      database,
      placements,
      repositories,
      repository,
      harness,
      active,
      authority,
      bind,
      get,
    };
  }

  it("keeps mirror acceptance immutable and refuses activation until it settles", async () => {
    const f = await fixture();
    const claim = await f.placements.claimTurn(makeClaimInput(f.active, "mirror-result"));
    await f.placements.markWorkspaceResultPending(claim);
    await expect(f.bind()).rejects.toThrow("Settle the pending mirrored workspace result");
    await f.placements.markWorkspaceResultPending(claim);
    const [pending] = await f.placements.listPendingWorkspaceResultsAsync();
    expect(pending).not.toHaveProperty("repositoryDiskAuthority");
    await f.placements.acceptWorkspaceResult(claim);
    await f.placements.completeWorkspaceResultAndReleaseTurn(claim);
    const prepared = await f.repositories.prepare(f.repository.workspaceId);
    const bound = await f.bind();
    expect(prepared.current()?.diskAuthority).toEqual(f.authority);
    expect(() =>
      Object.assign(prepared.current()!.diskAuthority!.resourceReceipt.identity, {
        diskId: "caller-replacement",
      }),
    ).toThrow();
    expect(bound.diskAuthority).toEqual(f.authority);
    await expect(
      f.repositories.bindDisk({
        workspaceId: bound.workspaceId,
        expectedRevision: bound.revision,
        diskAuthority: { ...f.authority, environmentId: "replacement-environment" },
        assertCurrent,
      }),
    ).rejects.toThrow("disk authority is immutable");
    await expect(
      f.repositories.acceptCheckpoint({
        workspaceId: bound.workspaceId,
        expectedRevision: bound.revision,
        checkpointRef: "refs/openclaw/worker-results/stale-mirror",
        manifestHash: "sha256:" + "c".repeat(64),
        assertCurrent,
      }),
    ).rejects.toThrow("cannot accept a mirrored checkpoint");
    expect(await f.repositories.get(bound.workspaceId)).toEqual(bound);
  });

  it.each(["missing", "replacement", "cleanup-failure", "drained", "exact", "accepted"] as const)(
    "recovers the accepted disk result without replay or mirror restore: %s",
    async (condition) => {
      const f = await fixture();
      await f.bind();
      const claim = await f.placements.claimTurn(makeClaimInput(f.active, "disk-result"));
      await f.placements.markWorkspaceResultPending(claim);
      const restarted = createWorkerSessionPlacementStore({
        database: f.database,
        now: () => 2_000,
      });
      const [pending] = await restarted.listPendingWorkspaceResultsAsync();
      expect(pending).toMatchObject({
        repositoryWorkspaceId: f.repository.workspaceId,
        repositoryDiskAuthority: f.authority,
        stagedResultRef: null,
        workspaceAcceptedAtMs: null,
      });
      expect(
        (await restarted.readProjection([REQUEST.sessionId], { current: true })).pendingResults.get(
          REQUEST.sessionId,
        ),
      ).toEqual(pending);
      await expect(
        f.placements.recordStagedWorkspaceResult(
          claim,
          "refs/openclaw/worker-results/stale",
          f.repository.workspaceId,
        ),
      ).rejects.toThrow("cannot stage a mirrored checkpoint");
      if (condition === "missing") {
        f.get.mockReturnValue(undefined);
      } else if (condition === "replacement") {
        const original = f.get(f.active.environmentId)!;
        f.get.mockReturnValue({
          ...original,
          resourceReceipt: {
            ...f.authority.resourceReceipt,
            identity: { diskId: "replacement-disk" },
          },
        });
      } else if (condition === "cleanup-failure") {
        vi.mocked(f.harness.environments.stopTunnel).mockRejectedValue(
          new Error("cleanup not confirmed"),
        );
      }
      if (condition === "drained") {
        vi.mocked(f.harness.environments.stopTunnel).mockImplementation(async () => {
          await f.placements.startDrain({
            sessionId: f.active.sessionId,
            expectedGeneration: f.active.generation,
            environmentId: f.active.environmentId,
            ownerEpoch: f.active.activeOwnerEpoch,
          });
        });
      }
      if (condition === "accepted") {
        await f.placements.acceptWorkspaceResult(claim);
      }
      await f.placements.handoffWorkspaceResultRecovery(claim);
      await f.harness.service.reconcileActive();
      if (condition === "cleanup-failure" || condition === "drained") {
        expect(f.harness.environments.stopTunnel).toHaveBeenCalledOnce();
      }
      expect(f.harness.environments.destroy).not.toHaveBeenCalled();
      expect(f.harness.environments.reclaim).not.toHaveBeenCalled();
      expect(f.harness.environments.startTunnel).not.toHaveBeenCalled();
      expect(f.harness.environments.createWithRequest).not.toHaveBeenCalled();
      if (condition === "exact" || condition === "accepted") {
        expect(await restarted.listPendingWorkspaceResultsAsync()).toEqual([]);
        expect((await restarted.getAsync(REQUEST.sessionId))?.turnClaim).toBeNull();
      } else {
        expect(await restarted.listPendingWorkspaceResultsAsync()).toMatchObject([
          {
            claimId: claim.claimId,
            repositoryDiskAuthority: f.authority,
            workspaceAcceptedAtMs: null,
          },
        ]);
      }
    },
  );
});
