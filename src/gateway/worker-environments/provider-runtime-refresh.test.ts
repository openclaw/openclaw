import { describe, expect, it, vi } from "vitest";
import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { NODE_WORKER_ENVIRONMENT_STOP_COMMAND } from "../../infra/node-commands.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { installWorkerPlacementReconcileGuard } from "../server-worker-placement-reconcile-guard.js";
import {
  createManager as createNodeTunnelManager,
  transport as createNodeTransport,
  withWorkspaceDrain,
  workspaceTransfer,
} from "./node-worker-tunnel.test-support.js";
import { REQUEST, seedActivePlacement } from "./placement-dispatch-test-fixtures.js";
import { createHarness, createRecoveryService } from "./placement-dispatch-test-harness.js";
import { WORKER_PROTOCOL_FEATURES } from "./placement-lifecycle.test-support.js";
import { projectWorkerSessionTurnClaim } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";
import { testState } from "./service.test-support.js";
import { createWorkerTunnelManager } from "./tunnel.js";

describe("worker environment runtime upgrades", () => {
  support.setupWorkerEnvironmentServiceSuite();

  const currentReceipt = {
    ...support.BOOTSTRAP_RECEIPT,
    bundleHash: "b".repeat(64),
    openclawVersion: "2026.9.27",
    protocolFeatures: WORKER_PROTOCOL_FEATURES.toSorted(),
  };
  const installedReceipt = { ...currentReceipt, installKind: "bundle" as const };
  type InstallNodeBundle = NonNullable<
    support.WorkerEnvironmentServiceOptions["ensureNodeWorkerBundle"]
  >;
  const unsupported = (message: string) =>
    vi.fn(async () => {
      throw new Error(message);
    });

  async function setupUpgrade(
    transport: "node" | "ssh",
    state: "idle" | "attached" = "attached",
    bootstrapReceipt: WorkerAdmissionHandshake = support.BOOTSTRAP_RECEIPT,
    targetReceipt: WorkerAdmissionHandshake = currentReceipt,
  ) {
    const environmentId = "worker-runtime-upgrade";
    type Transition = Parameters<typeof testState.store.transition>[0];
    const transition = (
      from: Transition["from"],
      to: Transition["to"],
      patch?: Transition["patch"],
    ) => testState.store.transition({ environmentId, from, to, patch });
    const node = transport === "node";
    await testState.store.createIntent({
      environmentId,
      providerId: "fake",
      profileId: "development",
      profileSnapshot: { settings: { region: "test", desktop: true } },
      provisionOperationId: `provision:${environmentId}`,
    });
    await transition("requested", "provisioning");
    if (!node) {
      await transition("provisioning", "bootstrapping", {
        leaseId: `lease:${environmentId}`,
        sshEndpoint: support.SSH_ENDPOINT,
      });
    }
    await transition(node ? "provisioning" : "bootstrapping", "ready", {
      ...support.readyPatch(environmentId, { ...bootstrapReceipt, installKind: "bundle" }),
      desktop: support.DESKTOP,
      ...(node ? { leaseId: `lease:${environmentId}`, nodeDeviceId: `node:${environmentId}` } : {}),
    });
    const environment = await transition(
      "ready",
      state,
      state === "attached" ? support.attachedPatch(environmentId, REQUEST.sessionId) : undefined,
    );
    const owner = { environmentId, ownerEpoch: environment.ownerEpoch };
    const placementStore = () =>
      createWorkerSessionPlacementStore({
        database: testState.stateDb,
        now: () => testState.nowMs,
      });
    const placements = placementStore();
    const placement =
      state === "attached"
        ? await seedActivePlacement(placements, {
            ...owner,
            executionMode: transport === "node" ? "worker-turn" : "remote-exec",
          })
        : undefined;
    const oldCredential = testState.store.getCredential(environmentId)!;
    const events: string[] = [];
    const tunnelManager = createWorkerTunnelManager();
    const stop = vi.spyOn(tunnelManager, "stop").mockImplementation(async () => {
      expect(testState.store.getCredential(environmentId)).toBeUndefined();
      events.push("stopped");
    });
    const install = vi.fn(async () => {
      expect(events.at(-1)).toBe("stopped");
      expect(testState.store.getCredential(environmentId)).toBeUndefined();
      events.push("installed");
      return targetReceipt;
    });
    testState.prepareInstallation = vi.fn(async () => ({
      ...support.BUNDLE_ARTIFACT,
      ...targetReceipt,
    }));
    testState.bootstrapWorker = vi.fn(async ({ installation, sshEndpoint }) => {
      expect(installation.bundleHash).toBe(targetReceipt.bundleHash);
      expect(sshEndpoint).toEqual(environment.sshEndpoint);
      return install();
    });
    const provider = {
      provision: vi.fn(support.createProvider().provision),
      destroy: vi.fn(async () => {}),
    };
    const ensureNodeWorkerBundle = vi.fn<InstallNodeBundle>(async (params) => {
      expect(params).toMatchObject({
        deviceId: environment.nodeDeviceId,
        artifact: { bundleHash: targetReceipt.bundleHash },
      });
      params.assertCurrent?.();
      return install();
    });
    const nodeTunnelManager: NonNullable<
      support.WorkerEnvironmentServiceOptions["nodeTunnelManager"]
    > = {
      status: () => "stopped",
      observeProcesses: unsupported("Process observation is not configured in this fixture"),
      start: unsupported("Node workspace transport was not configured"),
      stop: vi.fn(async () => {}),
      stopAll: vi.fn(async () => {}),
      beginClose: vi.fn(),
    };
    const bindService = async (store: typeof placements, restarting = false) => {
      const gate = createWorkerSessionPlacementGate(store, {
        recoveryPlacements: restarting ? await store.listAsync() : [],
      });
      const service = support.createService(
        support.createProvider({
          supportedExecutionModes: ["worker-turn", "remote-exec"],
          ...provider,
        }),
        {
          tunnelManager,
          nodeTunnelManager,
          placementStore: gate,
          ensureNodeWorkerBundle,
        },
      );
      return { gate, service };
    };
    const { service } = await bindService(placements);
    return {
      environment,
      owner,
      placement,
      placements,
      oldCredential,
      events,
      stop,
      install,
      ...provider,
      ensureNodeWorkerBundle,
      service,
      tunnelManager,
      nodeTunnelManager,
      readEnvironment: () => testState.store.get(environmentId),
      readCredential: () => testState.store.getCredential(environmentId),
      expectRetained: (fields: Partial<typeof environment>) => {
        const { leaseId, ownerEpoch } = environment;
        expect(testState.store.get(environmentId)).toMatchObject({
          state,
          leaseId,
          ownerEpoch,
          ...fields,
        });
      },
      restart: async () => {
        await support.reopenWorkerEnvironmentStore();
        const restarted = placementStore();
        await restarted.recoverWorkerSessionToolOperationsAfterRestart();
        await restarted.clearLocalTurnClaimsAfterRestartAsync();
        return { placements: restarted, ...(await bindService(restarted, true)) };
      },
    };
  }

  it("upgrades the node idle runtime while retaining its machine and workspace", async () => {
    const h = await setupUpgrade("node", "idle");
    await h.service.reconcileOnce();
    expect(h.events).toEqual(["stopped", "installed"]);
    expect(h.stop).toHaveBeenCalledWith(h.environment.environmentId, h.environment.ownerEpoch);
    expect(h.provision).not.toHaveBeenCalled();
    expect(h.destroy).not.toHaveBeenCalled();
    h.expectRetained({
      nodeDeviceId: h.environment.nodeDeviceId,
      desktop: h.environment.desktop,
      attachedSessionIds: h.environment.attachedSessionIds,
      bootstrapReceipt: installedReceipt,
      destroyRequestedAtMs: null,
    });
    expect(h.readCredential()).toMatchObject({
      bundleHash: currentReceipt.bundleHash,
      ownerEpoch: h.environment.ownerEpoch,
      sessionId: null,
    });
    expect(h.readCredential()?.credentialHash).not.toBe(h.oldCredential.credentialHash);
    expect(h.ensureNodeWorkerBundle).toHaveBeenCalledOnce();
  });

  it("exposes an in-flight node refresh and isolates progress listeners until it settles", async () => {
    const h = await setupUpgrade("node");
    const installing = createDeferred<() => void>();
    const installed = createDeferred<typeof currentReceipt>();
    h.ensureNodeWorkerBundle.mockImplementationOnce(async (params) => {
      params.assertCurrent?.();
      installing.resolve(() => params.onProgress?.());
      return installed.promise;
    });
    const recovery = h.service.reconcileOnce();
    const reportProgress = await installing.promise;
    const refresh = h.service.readRuntimeRefresh(h.environment.environmentId);
    const listener = vi.fn();
    let unsubscribe: (() => void) | undefined;
    let unsubscribeThrowing: (() => void) | undefined;
    try {
      expect(refresh).toBeDefined();
      unsubscribeThrowing = refresh!.onProgress(() => {
        throw new Error("progress listener failed");
      });
      unsubscribe = refresh!.onProgress(listener);
      expect(() => reportProgress()).not.toThrow();
      expect(listener).toHaveBeenCalledOnce();
      unsubscribe();
      reportProgress();
      expect(listener).toHaveBeenCalledOnce();
    } finally {
      unsubscribe?.();
      unsubscribeThrowing?.();
      installed.resolve(currentReceipt);
      await recovery;
    }
    await expect(refresh!.settled).resolves.toBeUndefined();
    expect(h.service.readRuntimeRefresh(h.environment.environmentId)).toBeUndefined();
    expect(h.readEnvironment()).toMatchObject({
      bootstrapReceipt: installedReceipt,
      lastError: null,
    });
    expect(h.placements.get(REQUEST.sessionId)?.workerBundleHash).toBe(currentReceipt.bundleHash);
  });

  it("bounds shutdown while guarded reconciliation is already waiting for a remote stop", async () => {
    const h = await setupUpgrade("node");
    const transport = createNodeTransport();
    const nodes = await transport.listCurrentNodes();
    transport.listCurrentNodes = async () => [
      { ...nodes[0]!, nodeId: h.environment.nodeDeviceId! },
    ];
    const entered = createDeferred();
    const release = createDeferred();
    transport.invoke = withWorkspaceDrain(async ({ command }) => {
      expect(command).toBe(NODE_WORKER_ENVIRONMENT_STOP_COMMAND);
      entered.resolve();
      await release.promise;
      return { ok: true, payloadJSON: "null" };
    });
    const transfer = workspaceTransfer();
    transfer.closeAll = vi.fn(async () => {});
    Object.assign(
      h.nodeTunnelManager,
      createNodeTunnelManager(h.environment, {
        getTransport: () => transport,
        workspaceTransfer: transfer,
      }),
    );
    installWorkerPlacementReconcileGuard({
      placements: h.placements,
      environments: h.service,
      dispatch: {
        resumeProvisioning: unsupported("Attached runtime refresh does not provision"),
        hasPendingPlacementLifecycleOperation: () => false,
      },
      isStopping: h.service.isStopping,
    });
    const reconciling = h.service.reconcileOnce();
    await entered.promise;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let stopped = false;
    const stopping = h.service.stop().then(() => {
      stopped = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(stopped).toBe(true);
      h.expectRetained({
        bootstrapReceipt: h.environment.bootstrapReceipt,
        attachedSessionIds: h.environment.attachedSessionIds,
        destroyRequestedAtMs: null,
      });
      expect(h.install).not.toHaveBeenCalled();
      expect(h.destroy).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.all([reconciling, stopping]);
      vi.useRealTimers();
    }
  });

  it("keeps an idle SSH machine through startup recovery when its runtime upgrade must retry", async () => {
    const h = await setupUpgrade("ssh", "attached", {
      ...support.BOOTSTRAP_RECEIPT,
      protocolFeatures: currentReceipt.protocolFeatures,
    });
    const recovery = await createRecoveryService(h.placements, h.service);
    h.install.mockRejectedValueOnce(new Error("runtime download interrupted"));

    await recovery.reconcile("startup");

    expect(h.install).toHaveBeenCalledOnce();
    expect(h.destroy).not.toHaveBeenCalled();
    expect(h.placements.get(REQUEST.sessionId)).toEqual(h.placement);
    h.expectRetained({
      bootstrapReceipt: h.environment.bootstrapReceipt,
      destroyRequestedAtMs: null,
      lastError: "runtime download interrupted",
    });

    await recovery.reconcileActive(h.environment.environmentId);

    expect(h.install).toHaveBeenCalledTimes(2);
    expect(h.provision).not.toHaveBeenCalled();
    expect(h.destroy).not.toHaveBeenCalled();
    expect(h.placements.get(REQUEST.sessionId)).toEqual({
      ...h.placement,
      workerBundleHash: currentReceipt.bundleHash,
    });
    h.expectRetained({
      bootstrapReceipt: installedReceipt,
      lastError: null,
    });
  });

  it.each(["unchanged build", "same-version build"] as const)(
    "recovers published Gateway Stop state after restart with %s",
    async (change) => {
      // v2026.9.6 placement-reclaim persists these shapes; current admission owns the schema.
      const releasedReceipt = {
        ...currentReceipt,
        ...support.BOOTSTRAP_RECEIPT,
        openclawVersion: "2026.9.6",
        protocolFeatures: currentReceipt.protocolFeatures,
      };
      const unchanged = change === "unchanged build";
      const targetReceipt = unchanged
        ? releasedReceipt
        : { ...currentReceipt, openclawVersion: releasedReceipt.openclawVersion };
      const h = await setupUpgrade(
        unchanged ? "node" : "ssh",
        "attached",
        releasedReceipt,
        targetReceipt,
      );
      await h.placements.startDrain({
        sessionId: REQUEST.sessionId,
        ...h.owner,
        expectedGeneration: h.placement!.generation,
      });
      if (!unchanged) {
        await h.placements.claimReclaimWorkspaceResult({
          ...REQUEST,
          claimId: "reclaim-runtime-upgrade",
          runId: "reclaim-runtime-upgrade",
          owner: { kind: "local", ...h.owner },
        });
      }
      const restarted = await h.restart();
      expect(restarted.placements.get(REQUEST.sessionId)).toMatchObject({
        state: "draining",
        turnClaim: null,
      });
      expect(await restarted.placements.listPendingWorkspaceResultsAsync()).toEqual(
        unchanged
          ? []
          : [
              expect.objectContaining({
                ...h.owner,
                gatewayInstanceId: h.placements.workspaceResultInstanceId(),
                workspaceAcceptedAtMs: null,
                stagedResultRef: null,
              }),
            ],
      );
      const fixture = await createHarness(testState.stateDb, restarted.placements, {
        workspacePath: testState.root,
      });
      const openWorkspace = async () => {
        expect(h.events).toEqual(unchanged ? [] : ["stopped", "installed"]);
        return {
          ...fixture.tunnelHandle(h.environment.ownerEpoch),
          environmentId: h.environment.environmentId,
        };
      };
      vi.spyOn(h.tunnelManager, "start").mockImplementation(openWorkspace);
      vi.mocked(h.nodeTunnelManager.start).mockImplementation(openWorkspace);
      h.destroy.mockImplementation(async () => {
        expect(fixture.log).toContain("workspace:verify-local");
        expect(await restarted.placements.listPendingWorkspaceResultsAsync()).toMatchObject([
          { workspaceAcceptedAtMs: expect.any(Number) },
        ]);
        fixture.log.push("provider:release");
      });
      const publicationAuthority: boolean[] = [];
      const unsubscribe = sessionChanges.subscribeFacts(() => {
        const placement = restarted.placements.get(REQUEST.sessionId);
        const claim = placement && projectWorkerSessionTurnClaim(placement);
        if (claim) {
          publicationAuthority.push(restarted.gate.validateWorkerTurn(claim));
        }
      });
      const reconcileEnvironment = restarted.service.reconcileEnvironment;
      vi.spyOn(restarted.service, "reconcileEnvironment").mockImplementation(
        async (environmentId) => {
          if (unchanged) {
            const placement = restarted.placements.get(REQUEST.sessionId)!;
            const claim = projectWorkerSessionTurnClaim(placement)!;
            expect(restarted.placements.validateWorkspaceResultClaim(claim)).toBe(true);
            expect(restarted.gate.validateWorkerTurn(claim)).toBe(false);
            const before = testState.store.getCredential(environmentId);
            await expect(restarted.service.acquireTurnCredential(claim)).rejects.toThrow(
              "not authoritative",
            );
            expect(testState.store.getCredential(environmentId)).toEqual(before);
            if (!before) {
              throw new Error("Released-state fixture lost its retained credential");
            }
            const identity = {
              ...before,
              credentialExpiresAtMs: before.expiresAtMs,
              protocolFeatures: releasedReceipt.protocolFeatures,
              runId: claim.runId,
              turnClaim: claim,
            };
            expect(restarted.service.validateWorkerConnection(identity)).toBe("placement-mismatch");
            await expect(
              restarted.service.commitTranscript(
                identity,
                support.transcriptRequest(identity, "recovery cannot execute"),
              ),
            ).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
            await expect(
              restarted.service.pushLiveEvent(
                identity,
                support.assistantEvent(identity, "recovery cannot execute"),
              ),
            ).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
            fixture.log.push("worker-authority:denied-before-io");
          }
          await reconcileEnvironment(environmentId);
        },
      );
      const recovery = await createHarness(testState.stateDb, restarted.placements, {
        workspacePath: testState.root,
        environmentService: restarted.service,
      });
      try {
        await recovery.service.reconcile("startup");
        if (unchanged) {
          expect(publicationAuthority).toContain(false);
          expect(publicationAuthority).not.toContain(true);
        }
        expect(h.install).toHaveBeenCalledTimes(unchanged ? 0 : 1);
        expect(h.destroy).toHaveBeenCalledOnce();
        expect(h.provision).not.toHaveBeenCalled();
        expect(restarted.placements.get(REQUEST.sessionId)).toMatchObject({
          state: "reclaimed",
          turnClaim: null,
          workspaceBaseManifestRef: fixture.reconciledManifestRef,
        });
        expect(await restarted.placements.listPendingWorkspaceResultsAsync()).toEqual([]);
      } finally {
        unsubscribe();
      }
    },
  );

  it.each(["shutdown", "destroy", "move", "live turn"] as const)(
    "rejects a finished installation after %s closes its authority",
    async (race) => {
      const h = await setupUpgrade("node");
      const started = createDeferred();
      const installed = createDeferred<typeof currentReceipt>();
      h.install.mockImplementationOnce(async () => {
        started.resolve();
        return installed.promise;
      });
      const recovery = h.service.reconcileOnce();
      await started.promise;
      let stopping: Promise<void> | undefined;
      if (race === "shutdown") {
        stopping = h.service.stop();
      } else if (race === "destroy") {
        await testState.store.requestDestroy({
          environmentId: h.environment.environmentId,
          state: "attached",
        });
      } else if (race === "move") {
        await h.placements.beginPlacementMove({
          sessionId: REQUEST.sessionId,
          source: { generation: h.placement!.generation, ...h.owner },
          target: { kind: "gateway" },
        });
      } else {
        await h.placements.claimTurn({
          ...REQUEST,
          claimId: "new-live-claim",
          runId: "new-live-run",
          owner: { kind: "worker", ...h.owner },
        });
      }
      installed.resolve(currentReceipt);
      await recovery;
      await stopping;
      expect(h.readEnvironment()?.bootstrapReceipt).toEqual(h.environment.bootstrapReceipt);
      expect(h.placements.get(REQUEST.sessionId)?.workerBundleHash).toBe(
        h.placement!.workerBundleHash,
      );
      expect(h.readCredential()).toBeUndefined();
      expect(h.provision).not.toHaveBeenCalled();
      expect(h.destroy).not.toHaveBeenCalled();
    },
  );
});
