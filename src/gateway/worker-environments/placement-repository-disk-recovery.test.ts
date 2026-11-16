import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, assert, beforeAll, describe, expect, it, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
} from "../../../test/helpers/fixture-receipts.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
  NODE_WORKER_WORKSPACE_EXEC_COMMAND,
} from "../../infra/node-commands.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import type { WorkerResourceReceipt } from "../../plugins/capability-provider.types.js";
import { createSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import {
  createWorkerWorkspaceRecoveryPreparer,
  loadWorkerPlacementSessionRuntimeModule,
} from "../server-worker-placement-session-target.js";
import { createNodeWorkerLaunchAdapter } from "./node-launch-adapter.js";
import { nodeWorkerGatewayNamespace } from "./node-worker-gateway-namespace.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { openDiskCleanupTransport } from "./placement-disk-cleanup.test-support.js";
import { REQUEST, seedActivePlacement } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { makeClaimInput } from "./placement-lifecycle.test-support.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { writePlacementEnvironmentFixture } from "./placement-test-fixtures.js";
import * as support from "./service.test-support.js";
import { createWorkerEnvironmentStore } from "./store.js";

const assertCurrent = () => {};

describe("repository disk authority and pending-result recovery", () => {
  support.setupWorkerEnvironmentServiceSuite();
  afterEach(() => vi.unstubAllEnvs());

  async function fixture(executionMode: "worker-turn" | "remote-exec" = "worker-turn") {
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
    const active = await harness.placements.seedActive(2, executionMode);
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

  it.each([
    "missing",
    "replacement",
    "cleanup-failure",
    "drained",
    "exact",
    "accepted",
    "local-restart",
  ] as const)(
    "recovers the accepted disk result without replay or mirror restore: %s",
    async (condition) => {
      const f = await fixture(condition === "local-restart" ? "remote-exec" : "worker-turn");
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
      if (condition === "local-restart") {
        await restarted.clearLocalTurnClaimsAfterRestartAsync();
      }
      await f.harness.service.reconcileActive();
      if (condition === "cleanup-failure" || condition === "drained") {
        expect(f.harness.environments.stopTunnel).toHaveBeenCalledOnce();
      }
      expect(f.harness.environments.destroy).not.toHaveBeenCalled();
      expect(f.harness.environments.reclaim).not.toHaveBeenCalled();
      expect(f.harness.environments.startTunnel).not.toHaveBeenCalled();
      expect(f.harness.environments.createWithRequest).not.toHaveBeenCalled();
      if (condition === "exact" || condition === "accepted" || condition === "local-restart") {
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

describe("disk recovery through the private node cleanup transport", () => {
  support.setupWorkerEnvironmentServiceSuite();
  let wire: Awaited<ReturnType<typeof openDiskCleanupTransport>>;
  beforeAll(async () => {
    wire = await openDiskCleanupTransport();
  });
  afterAll(async () => {
    await wire.close();
  });
  afterEach(() => vi.unstubAllEnvs());

  it.for(["original", "other-session", "activeWriterRunId", "lifecycleRevision"] as const)(
    "settles only the retained disk/session owner: %s",
    async (condition, { signal }) => {
      const { root, stateDb: database, store } = support.testState;
      vi.stubEnv("OPENCLAW_STATE_DIR", root);
      const events: string[] = [];
      const placements = createWorkerSessionPlacementStore({ database });
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
      const environmentId = "disk-cleanup-environment";
      const bootstrapping = await support.seedBootstrapping(environmentId, "bundle");
      await store.transition({
        environmentId,
        from: "bootstrapping",
        to: "ready",
        patch: {
          ...support.readyPatch(environmentId),
          nodeDeviceId: wire.nodeId,
          sshEndpoint: null,
        },
      });
      const attached = await store.transition({
        environmentId,
        from: "ready",
        to: "attached",
        patch: support.attachedPatch(environmentId, REQUEST.sessionId),
      });
      const active = await seedActivePlacement(placements, {
        environmentId,
        ownerEpoch: attached.ownerEpoch,
      });
      assert(active.state === "active" && bootstrapping.leaseId);
      const resourceReceipt: WorkerResourceReceipt = {
        version: 1,
        leaseId: bootstrapping.leaseId,
        identity: { machineId: "original-machine", diskId: "original-disk" },
      };
      await store.recordResourceReceipt({
        environmentId,
        provisionOperationId: attached.provisionOperationId,
        receipt: resourceReceipt,
        assertCurrent,
      });
      const bound = await repositories.bindDisk({
        workspaceId: repository.workspaceId,
        expectedRevision: repository.revision,
        diskAuthority: { environmentId, resourceReceipt },
        assertCurrent,
      });
      const scope = { ...REQUEST, storePath: path.join(root, "sessions.sqlite") };
      support.testState.config = {
        ...support.testState.config,
        agents: { entries: { main: {} } },
        session: { store: scope.storePath, maintenance: { mode: "warn" } },
      };
      setRuntimeConfigSnapshot(support.testState.config);
      await upsertSessionEntryCore(scope, {
        sessionId: REQUEST.sessionId,
        updatedAt: 1,
        lifecycleRevision: "original-lifecycle",
        activeWriterRunId: "original-writer",
        repositoryWorkspaceId: bound.workspaceId,
      });
      const beforeTranscript = await loadTranscriptEvents(scope);
      const transfer = createNodeWorkspaceTransferService({
        temporaryRoot: path.join(root, "transfers"),
        getOwner: (id) => {
          const environment = store.get(id);
          return environment ? { environment, credential: store.getCredential(id) } : undefined;
        },
      });
      const transferPreparation = vi.spyOn(transfer, "prepareRepository");
      const tunnels = createNodeWorkerTunnelManager({
        gatewayDeviceId: "disk-cleanup-gateway",
        getEnvironment: store.get,
        listEnvironments: store.list,
        getTransport: () => wire.transport,
        workspaceTransfer: transfer,
        launchNodeWorker: createNodeWorkerLaunchAdapter({ getTransport: () => wire.transport })
          .launch,
        validateWorkerTurn: (claim) => placements.validateTurnClaim(claim),
      });
      const service = support.createService(support.createProvider(), {
        nodeTunnelManager: tunnels,
      });
      const prohibited = ["destroy", "reclaim", "startTunnel", "createWithRequest"] as const;
      const prohibitedCalls = prohibited.map((method) => vi.spyOn(service, method));
      // Observe real database effects without supplying their decisions or results.
      const accept = placements.acceptWorkspaceResult.bind(placements);
      vi.spyOn(placements, "acceptWorkspaceResult").mockImplementation(async (...args) => {
        await accept(...args);
        events.push("accept");
      });
      const release = placements.completeWorkspaceResultAndReleaseTurn.bind(placements);
      vi.spyOn(placements, "completeWorkspaceResultAndReleaseTurn").mockImplementation(
        async (...args) => {
          const result = await release(...args);
          events.push("release");
          return result;
        },
      );
      const harness = await createHarness(database, placements, {
        environmentService: service,
        withPreparedRecovery: createWorkerWorkspaceRecoveryPreparer({
          loadSessionRuntime: loadWorkerPlacementSessionRuntimeModule,
          getConfig: () => support.testState.config,
        }),
        // No publication is configured. These observers establish whether recovery
        // reaches the production publication boundary, not remote GitHub success.
        prepareAcceptedWorkspacePublication: async () => {
          events.push("prepare-publication");
        },
        publishAcceptedWorkspace: async () => {
          events.push("publish");
        },
      });
      const claim = await placements.claimTurn(makeClaimInput(active, "disk-wire-result"));
      await placements.markWorkspaceResultPending(claim);
      await placements.handoffWorkspaceResultRecovery(claim);
      const pending = await placements.listPendingWorkspaceResultsAsync();
      if (condition === "other-session") {
        // A nearest-neighbor durable fault, not a legal reattachment (which advances
        // the epoch): change only the session through the existing fixture writer.
        writePlacementEnvironmentFixture(database, {
          ...store.get(environmentId)!,
          attachedSessionIds: ["session-2"],
        });
        expect(store.get(environmentId)).toMatchObject({
          ownerEpoch: attached.ownerEpoch,
          resourceReceipt,
        });
      }
      const workspace = new NodeWorkerWorkspaceRuntime({
        root: path.join(root, "node"),
        env: { PATH: path.dirname(process.execPath), HOME: root, NODE_DISABLE_COMPILE_CACHE: "1" },
      });
      const receipts = await openFixtureReceiptChannel();
      const stopEntered = createDeferred();
      const releaseStop = createDeferred();
      const revoked = condition === "activeWriterRunId" || condition === "lifecycleRevision";
      wire.bind({
        workspace,
        events,
        beforeStop: async () => {
          stopEntered.resolve();
          if (revoked) {
            await releaseStop.promise;
          }
        },
      });
      const marker = "retained-result.txt";
      const source = JSON.stringify(root);
      const foreground = workspace
        .exec({
          gatewayNamespace: nodeWorkerGatewayNamespace("disk-cleanup-gateway"),
          environmentId,
          sessionId: REQUEST.sessionId,
          generation: attached.ownerEpoch,
          nativeProcessOwner: true,
          argv: [
            path.basename(process.execPath),
            "--input-type=module",
            "-e",
            fixtureReceiptClientSource(receipts.endpoint) +
              '\nawait (await import("node:fs/promises")).writeFile(' +
              JSON.stringify(marker) +
              ', "retained disk output\\n");' +
              "\nsendReceipt(" +
              source +
              ', "ready"); await awaitRelease(' +
              source +
              ', "finish");',
          ],
        })
        .then((result) => {
          events.push("child:settled");
          return result;
        });
      let recovery: Promise<void> | undefined;
      try {
        await withinTest(
          Promise.race([
            receipts.waitFor(root, "ready"),
            foreground.then(() => {
              throw new Error("Foreground exited before readiness");
            }),
          ]),
          signal,
        );
        events.push("child:ready");
        recovery = harness.service.reconcileActive();
        if (revoked) {
          await withinTest(
            Promise.race([
              stopEntered.promise,
              recovery.then(() => {
                throw new Error("Recovery finished before cleanup dispatch");
              }),
            ]),
            signal,
          );
          await upsertSessionEntryCore(scope, { [condition]: "successor" });
          events.push("session:revoked");
          releaseStop.resolve();
        }
        await withinTest(recovery, signal);
        expect(wire.errors).toEqual([]);
        if (condition === "other-session") {
          expect(wire.commands).toEqual([]);
          expect(events).toEqual(["child:ready"]);
          receipts.release(root, "finish");
          expect(await withinTest(foreground, signal)).toMatchObject({ code: 0, killed: false });
        } else {
          expect(await withinTest(foreground, signal)).toMatchObject({ killed: true });
          expect(wire.commands).toEqual([
            NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
            NODE_WORKER_WORKSPACE_EXEC_COMMAND,
          ]);
          expect(events).toEqual([
            "child:ready",
            "stop:received",
            ...(revoked ? ["session:revoked"] : []),
            "child:settled",
            "stop:complete",
            "stop:ack",
            "drain:received",
            "drain:complete",
            "drain:ack",
            ...(!revoked ? ["prepare-publication", "accept", "publish", "release"] : []),
          ]);
        }
        await withinTest(receipts.waitForExit(root), signal);
        expect(await placements.listPendingWorkspaceResultsAsync()).toEqual(
          condition === "original" ? [] : pending,
        );
        expect((await placements.getAsync(REQUEST.sessionId))?.turnClaim?.claimId ?? null).toBe(
          condition === "original" ? null : claim.claimId,
        );
        expect(await repositories.get(bound.workspaceId)).toEqual(bound);
        const transcript = await loadTranscriptEvents(scope);
        if (condition === "other-session") {
          expect(transcript).toMatchObject([
            { type: "session", id: REQUEST.sessionId },
            {
              type: "custom_message",
              customType: "cloud-workspace-recovery-failed",
              details: {
                error:
                  "Disk-authoritative workspace recovery requires its exact active repository owner",
              },
            },
          ]);
        } else {
          expect(transcript).toEqual(beforeTranscript);
        }
        expect(await fs.readFile(path.join((await foreground).workspaceDir, marker), "utf8")).toBe(
          "retained disk output\n",
        );
        expect(transferPreparation).not.toHaveBeenCalled();
        for (const call of prohibitedCalls) {
          expect(call).not.toHaveBeenCalled();
        }
      } finally {
        releaseStop.resolve();
        await workspace.processes.close();
        await foreground.catch(() => undefined);
        await recovery;
        await receipts.close();
        // Close the service while its exact endpoint still exists. Test teardown
        // may repeat retained native cleanup; it is outside the recovery evidence.
        await service.stop();
        support.testState.service = undefined;
      }
    },
  );
});
