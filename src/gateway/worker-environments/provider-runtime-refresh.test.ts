import { describe, expect, it, vi } from "vitest";
import {
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
  type WorkerAdmissionHandshake,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { REQUEST, seedActivePlacement } from "./placement-dispatch-test-fixtures.js";
import { createHarness, createRecoveryService } from "./placement-dispatch-test-harness.js";
import { projectWorkerSessionTurnClaim } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";
import { createWorkerTunnelManager } from "./tunnel.js";

describe("worker environment runtime upgrades", () => {
  support.setupWorkerEnvironmentServiceSuite();

  const currentReceipt = {
    ...support.BOOTSTRAP_RECEIPT,
    bundleHash: "b".repeat(64),
    openclawVersion: "2026.9.27",
    protocolFeatures: [
      WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
      WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
    ],
  };

  async function setupUpgrade(
    transport: "node" | "ssh",
    state: "ready" | "idle" | "attached" = "attached",
    bootstrapReceipt: WorkerAdmissionHandshake = support.BOOTSTRAP_RECEIPT,
    targetReceipt: WorkerAdmissionHandshake = currentReceipt,
  ) {
    const environmentId = "worker-runtime-upgrade";
    await support.testState.store.createIntent({
      environmentId,
      providerId: "fake",
      profileId: "development",
      profileSnapshot: { settings: { region: "test", desktop: true } },
      provisionOperationId: `provision:${environmentId}`,
    });
    await support.testState.store.transition({
      environmentId,
      from: "requested",
      to: "provisioning",
    });
    if (transport === "ssh") {
      await support.testState.store.transition({
        environmentId,
        from: "provisioning",
        to: "bootstrapping",
        patch: { leaseId: `lease:${environmentId}`, sshEndpoint: support.SSH_ENDPOINT },
      });
    }
    const ready = await support.testState.store.transition({
      environmentId,
      from: transport === "node" ? "provisioning" : "bootstrapping",
      to: "ready",
      patch: {
        ...support.readyPatch(environmentId, { ...bootstrapReceipt, installKind: "bundle" }),
        desktop: support.DESKTOP,
        ...(transport === "node"
          ? { leaseId: `lease:${environmentId}`, nodeDeviceId: `node:${environmentId}` }
          : {}),
      },
    });
    const environment =
      state === "ready"
        ? ready
        : await support.testState.store.transition({
            environmentId,
            from: "ready",
            to: state,
            ...(state === "attached"
              ? { patch: support.attachedPatch(environmentId, REQUEST.sessionId) }
              : {}),
          });
    const placements = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });
    const placement =
      state === "attached"
        ? await seedActivePlacement(placements, {
            environmentId,
            ownerEpoch: environment.ownerEpoch,
            executionMode: transport === "node" ? "worker-turn" : "remote-exec",
          })
        : undefined;
    const oldCredential = support.testState.store.getCredential(environmentId)!;
    const events: string[] = [];
    const tunnelManager = createWorkerTunnelManager();
    const stop = vi.spyOn(tunnelManager, "stop").mockImplementation(async () => {
      expect(support.testState.store.getCredential(environmentId)).toBeUndefined();
      events.push("stopped");
    });
    const install = vi.fn(async () => {
      expect(events.at(-1)).toBe("stopped");
      expect(support.testState.store.getCredential(environmentId)).toBeUndefined();
      events.push("installed");
      return targetReceipt;
    });
    support.testState.prepareInstallation = vi.fn(async () => ({
      ...support.BUNDLE_ARTIFACT,
      ...targetReceipt,
    }));
    support.testState.bootstrapWorker = vi.fn(async ({ installation, sshEndpoint }) => {
      expect(installation.bundleHash).toBe(targetReceipt.bundleHash);
      expect(sshEndpoint).toEqual(environment.sshEndpoint);
      return install();
    });
    const provision = vi.fn(support.createProvider().provision);
    const destroy = vi.fn(async () => {});
    const ensureNodeWorkerBundle = vi.fn(
      async (
        params: Parameters<
          NonNullable<support.WorkerEnvironmentServiceOptions["ensureNodeWorkerBundle"]>
        >[0],
      ) => {
        expect(params.deviceId).toBe(environment.nodeDeviceId);
        expect(params.artifact.bundleHash).toBe(targetReceipt.bundleHash);
        params.assertCurrent?.();
        return install();
      },
    );
    const nodeTunnelManager: NonNullable<
      support.WorkerEnvironmentServiceOptions["nodeTunnelManager"]
    > = {
      status: () => "stopped",
      start: vi.fn(async () => {
        throw new Error("Node workspace transport was not configured");
      }),
      stop: vi.fn(async () => {}),
      stopAll: vi.fn(async () => {}),
    };
    const bindService = (store: typeof placements, restarting = false) => {
      const gate = createWorkerSessionPlacementGate(store, {
        rejectExistingWorkerClaims: restarting,
      });
      const service = support.createService(
        support.createProvider({
          supportedExecutionModes: ["worker-turn", "remote-exec"],
          provision,
          destroy,
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
    const { service } = bindService(placements);
    return {
      environment,
      placement,
      placements,
      oldCredential,
      events,
      stop,
      install,
      provision,
      destroy,
      ensureNodeWorkerBundle,
      service,
      tunnelManager,
      nodeTunnelManager,
      restart: async () => {
        await support.reopenWorkerEnvironmentStore();
        const restarted = createWorkerSessionPlacementStore({
          database: support.testState.stateDb,
          now: () => support.testState.nowMs,
        });
        restarted.recoverWorkerSessionToolOperationsAfterRestart();
        restarted.clearLocalTurnClaimsAfterRestart();
        return { placements: restarted, ...bindService(restarted, true) };
      },
    };
  }

  it.each([
    ["node", "attached"],
    ["ssh", "attached"],
    ["node", "ready"],
    ["node", "idle"],
  ] as const)(
    "upgrades the %s %s runtime while retaining its machine and workspace",
    async (transport, state) => {
      const h = await setupUpgrade(transport, state);
      await h.service.reconcileOnce();
      expect(h.events).toEqual(["stopped", "installed"]);
      expect(h.stop).toHaveBeenCalledWith(h.environment.environmentId, h.environment.ownerEpoch);
      expect(h.provision).not.toHaveBeenCalled();
      expect(h.destroy).not.toHaveBeenCalled();
      expect(support.testState.store.get(h.environment.environmentId)).toMatchObject({
        state,
        leaseId: h.environment.leaseId,
        ownerEpoch: h.environment.ownerEpoch,
        nodeDeviceId: h.environment.nodeDeviceId,
        desktop: h.environment.desktop,
        attachedSessionIds: h.environment.attachedSessionIds,
        bootstrapReceipt: { ...currentReceipt, installKind: "bundle" },
        destroyRequestedAtMs: null,
      });
      if (h.placement) {
        expect(h.placements.get(h.placement.sessionId)).toEqual({
          ...h.placement,
          workerBundleHash: currentReceipt.bundleHash,
        });
      }
      expect(support.testState.store.getCredential(h.environment.environmentId)).toMatchObject({
        bundleHash: currentReceipt.bundleHash,
        ownerEpoch: h.environment.ownerEpoch,
        sessionId: state === "attached" ? REQUEST.sessionId : null,
      });
      expect(
        support.testState.store.getCredential(h.environment.environmentId)?.credentialHash,
      ).not.toBe(h.oldCredential.credentialHash);
      expect(
        transport === "node" ? h.ensureNodeWorkerBundle : support.testState.bootstrapWorker,
      ).toHaveBeenCalledOnce();
    },
  );

  it.each(["node", "ssh"] as const)(
    "retains the %s machine after an interrupted install and retries its runtime",
    async (transport) => {
      const h = await setupUpgrade(transport);
      h.install.mockRejectedValueOnce(new Error("runtime download interrupted"));
      await h.service.reconcileOnce();
      expect(support.testState.store.get(h.environment.environmentId)).toMatchObject({
        state: "attached",
        leaseId: h.environment.leaseId,
        ownerEpoch: h.environment.ownerEpoch,
        bootstrapReceipt: h.environment.bootstrapReceipt,
        destroyRequestedAtMs: null,
        lastError: "runtime download interrupted",
      });
      expect(support.testState.store.getCredential(h.environment.environmentId)).toBeUndefined();
      expect(h.placements.get(REQUEST.sessionId)).toEqual(h.placement);
      await expect(
        h.service.startTunnel({
          environmentId: h.environment.environmentId,
          ownerEpoch: h.environment.ownerEpoch,
        }),
      ).rejects.toThrow(
        "Cloud worker runtime update is pending; recovery will retry when the worker is available: runtime download interrupted",
      );
      await h.service.reconcileOnce();
      expect(
        support.testState.store.get(h.environment.environmentId)?.bootstrapReceipt?.bundleHash,
      ).toBe(currentReceipt.bundleHash);
      expect(h.placements.get(REQUEST.sessionId)?.workerBundleHash).toBe(currentReceipt.bundleHash);
      expect(h.provision).not.toHaveBeenCalled();
      expect(h.destroy).not.toHaveBeenCalled();
    },
  );

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
    expect(support.testState.store.get(h.environment.environmentId)).toMatchObject({
      bootstrapReceipt: { ...currentReceipt, installKind: "bundle" },
      lastError: null,
    });
    expect(h.placements.get(REQUEST.sessionId)?.workerBundleHash).toBe(currentReceipt.bundleHash);
  });

  it("settles and clears a failed node refresh while retaining its existing error recovery", async () => {
    const h = await setupUpgrade("node");
    const installing = createDeferred();
    const installed = createDeferred<typeof currentReceipt>();
    h.install.mockImplementationOnce(async () => {
      installing.resolve();
      return installed.promise;
    });
    const recovery = h.service.reconcileOnce();
    await installing.promise;
    const refresh = h.service.readRuntimeRefresh(h.environment.environmentId);
    try {
      expect(refresh).toBeDefined();
    } finally {
      installed.reject(new Error("runtime download interrupted"));
      await recovery;
    }
    await expect(refresh!.settled).resolves.toBeUndefined();
    expect(h.service.readRuntimeRefresh(h.environment.environmentId)).toBeUndefined();
    expect(support.testState.store.get(h.environment.environmentId)).toMatchObject({
      state: "attached",
      bootstrapReceipt: h.environment.bootstrapReceipt,
      lastError: "runtime download interrupted",
    });
    expect(h.placements.get(REQUEST.sessionId)).toEqual(h.placement);
  });

  it("keeps an idle SSH machine through startup recovery when its runtime upgrade must retry", async () => {
    const h = await setupUpgrade("ssh", "attached", {
      ...support.BOOTSTRAP_RECEIPT,
      protocolFeatures: [
        WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
        WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
      ],
    });
    const recovery = createRecoveryService(h.placements, h.service);
    h.install.mockRejectedValueOnce(new Error("runtime download interrupted"));

    await recovery.reconcile("startup");

    expect(h.install).toHaveBeenCalledOnce();
    expect(h.destroy).not.toHaveBeenCalled();
    expect(h.placements.get(REQUEST.sessionId)).toEqual(h.placement);
    expect(support.testState.store.get(h.environment.environmentId)).toMatchObject({
      state: "attached",
      leaseId: h.environment.leaseId,
      ownerEpoch: h.environment.ownerEpoch,
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
    expect(support.testState.store.get(h.environment.environmentId)).toMatchObject({
      state: "attached",
      leaseId: h.environment.leaseId,
      ownerEpoch: h.environment.ownerEpoch,
      bootstrapReceipt: { ...currentReceipt, installKind: "bundle" },
      lastError: null,
    });
  });

  it.each(["unchanged build", "version", "same-version build"] as const)(
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
        : {
            ...currentReceipt,
            ...(change === "same-version build"
              ? { openclawVersion: releasedReceipt.openclawVersion }
              : {}),
          };
      const h = await setupUpgrade(
        unchanged ? "node" : "ssh",
        "attached",
        releasedReceipt,
        targetReceipt,
      );
      h.placements.startDrain({
        sessionId: REQUEST.sessionId,
        environmentId: h.environment.environmentId,
        ownerEpoch: h.environment.ownerEpoch,
        expectedGeneration: h.placement!.generation,
      });
      if (!unchanged) {
        h.placements.claimReclaimWorkspaceResult({
          ...REQUEST,
          claimId: "reclaim-runtime-upgrade",
          runId: "reclaim-runtime-upgrade",
          owner: {
            kind: "local",
            environmentId: h.environment.environmentId,
            ownerEpoch: h.environment.ownerEpoch,
          },
        });
      }
      const restarted = await h.restart();
      expect(restarted.placements.get(REQUEST.sessionId)).toMatchObject({
        state: "draining",
        turnClaim: null,
      });
      expect(restarted.placements.listPendingWorkspaceResults()).toEqual(
        unchanged
          ? []
          : [
              expect.objectContaining({
                environmentId: h.environment.environmentId,
                ownerEpoch: h.environment.ownerEpoch,
                gatewayInstanceId: h.placements.workspaceResultInstanceId(),
                workspaceAcceptedAtMs: null,
                stagedResultRef: null,
              }),
            ],
      );
      const fixture = createHarness(support.testState.stateDb, restarted.placements, {
        workspacePath: support.testState.root,
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
        expect(restarted.placements.listPendingWorkspaceResults()).toMatchObject([
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
            const before = support.testState.store.getCredential(environmentId);
            await expect(restarted.service.acquireTurnCredential(claim)).rejects.toThrow(
              "not authoritative",
            );
            expect(support.testState.store.getCredential(environmentId)).toEqual(before);
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
      const recovery = createHarness(support.testState.stateDb, restarted.placements, {
        workspacePath: support.testState.root,
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
        expect(restarted.placements.listPendingWorkspaceResults()).toEqual([]);
        console.info(
          `[stop-recovery-proof] published-state=v2026.9.6 case=${change} reopened=draining events=${fixture.log.join(",")} final=reclaimed`,
        );
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
        await support.testState.store.requestDestroy({
          environmentId: h.environment.environmentId,
          state: "attached",
        });
      } else if (race === "move") {
        h.placements.beginPlacementMove({
          sessionId: REQUEST.sessionId,
          source: {
            generation: h.placement!.generation,
            environmentId: h.environment.environmentId,
            ownerEpoch: h.environment.ownerEpoch,
          },
          target: { kind: "gateway" },
        });
      } else {
        await h.placements.claimTurn({
          ...REQUEST,
          claimId: "new-live-claim",
          runId: "new-live-run",
          owner: {
            kind: "worker",
            environmentId: h.environment.environmentId,
            ownerEpoch: h.environment.ownerEpoch,
          },
        });
      }
      installed.resolve(currentReceipt);
      await recovery;
      await stopping;
      expect(support.testState.store.get(h.environment.environmentId)?.bootstrapReceipt).toEqual(
        h.environment.bootstrapReceipt,
      );
      expect(h.placements.get(REQUEST.sessionId)?.workerBundleHash).toBe(
        h.placement!.workerBundleHash,
      );
      expect(support.testState.store.getCredential(h.environment.environmentId)).toBeUndefined();
      expect(h.provision).not.toHaveBeenCalled();
      expect(h.destroy).not.toHaveBeenCalled();
    },
  );
});
