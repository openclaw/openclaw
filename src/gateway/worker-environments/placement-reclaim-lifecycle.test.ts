import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { NODE_WORKER_ENVIRONMENT_STOP_COMMAND } from "../../infra/node-commands.js";
import {
  NODE_WORKSPACE_QUIESCENCE_COMMAND,
  type NodeWorkerWorkspaceExecInput,
} from "../../worker/node-workspace-protocol.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import * as nodeSupport from "./node-worker-tunnel.test-support.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import {
  createDispatchEnvironmentFixtures,
  MANIFEST_REF,
  REQUEST,
  seedActivePlacement,
} from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerPlacementIdleSweep } from "./placement-idle-sweep.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { placementClaim, placementSource } from "./placement-suite.test-support.js";
import * as support from "./service.test-support.js";
import type { WorkerTunnelManager } from "./tunnel.js";

support.setupWorkerEnvironmentServiceSuite();

it.each([
  { operation: "reclaim", failure: "timeout" },
  { operation: "move", failure: "rejection" },
  { operation: "recovery", failure: "rejection" },
  { operation: "reclaim", failure: "reconciliation" },
  { operation: "reclaim", failure: "resume-owner-close" },
] as const)(
  "preserves $operation $failure through quiescence and teardown",
  async ({ operation, failure }) => {
    const { stateDb: database, store: environments, root } = support.testState;
    let placements = createWorkerSessionPlacementStore({ database });
    const harnessOptions = {
      workspacePath: root,
      reconcileChanged: false,
      reconcileCommitsManifest: false,
    };
    let harness = await createHarness(database, placements, harnessOptions);
    const environmentId = harness.ready.environmentId;
    const build = createDispatchEnvironmentFixtures().attached.bootstrapReceipt;
    support.testState.prepareInstallation = async () => ({
      ...support.BUNDLE_ARTIFACT,
      ...build,
    });
    await support.seedBootstrapping(environmentId);
    await environments.transition({
      environmentId,
      from: "bootstrapping",
      to: "ready",
      patch: {
        ...support.readyPatch(environmentId, { ...build, installKind: "bundle" }),
        nodeDeviceId: "node-fixture",
        sharedHost: false,
        sshEndpoint: null,
      },
    });
    const attached = await environments.transition({
      environmentId,
      from: "ready",
      to: "attached",
      patch: support.attachedPatch(environmentId, REQUEST.sessionId),
    });
    const active = await harness.placements.seedActive(attached.ownerEpoch);
    if (active.state !== "active") {
      throw new Error("expected active placement");
    }
    if (operation === "recovery") {
      const claim = await placements.claimTurn(placementClaim(active, "pending"));
      await placements.markWorkspaceResultPending(claim);
      await placements.startWorkspaceResultDrain(claim);
      placements = createWorkerSessionPlacementStore({ database });
      harness = await createHarness(database, placements, harnessOptions);
    }
    harness.markEnvironmentOwnerEpoch(attached.ownerEpoch);
    const transport = nodeSupport.transport();
    const nodes = await transport.listCurrentNodes();
    nodes[0]!.nodeId = attached.nodeDeviceId!;
    transport.listCurrentNodes = async () => nodes;
    const invoke = vi.fn<typeof transport.invoke>(async ({ command, params }) => {
      if (command === NODE_WORKER_ENVIRONMENT_STOP_COMMAND) {
        return { ok: true, payloadJSON: "null" };
      }
      const input = params as NodeWorkerWorkspaceExecInput;
      const quiescence = input.quiescence;
      if (quiescence) {
        expect(input.argv).toEqual([NODE_WORKSPACE_QUIESCENCE_COMMAND, active.remoteWorkspaceDir]);
      }
      const stdout =
        quiescence?.action === "acquire"
          ? `quiesced ${quiescence.nonce}`
          : quiescence?.action === "renew"
            ? `renewed ${quiescence.nonce}`
            : MANIFEST_REF;
      return {
        ok: true,
        payloadJSON: nodeSupport.workspaceCommandPayload(active.remoteWorkspaceDir, { stdout }),
      };
    });
    transport.invoke = nodeSupport.withWorkspaceDrain(invoke);
    const releaseCalls = () =>
      invoke.mock.calls.filter(
        ([call]) => (call.params as NodeWorkerWorkspaceExecInput).quiescence?.action === "release",
      );
    const transfer = nodeSupport.workspaceTransfer({
      closeAll: vi.fn(async () => {}),
      prepareSync: vi.fn(async () => ({
        token: "fixture-transfer",
        snapshot: {
          root,
          manifest: { version: 1 as const, baseCommit: null, entries: [] },
          manifestRef: MANIFEST_REF,
          rawManifest: "",
        },
      })),
    });
    const tunnels = createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-fixture",
      getEnvironment: (id) => environments.get(id),
      listEnvironments: () => environments.list(),
      getTransport: () => transport,
      launchNodeWorker: vi.fn(),
      validateWorkerTurn: (claim) => placements.validateTurnClaim(claim),
      workspaceTransfer: transfer,
    });
    tunnels.bindWorkspaceBindingResolver(async () => ({
      source: { kind: "local", path: root },
      remoteWorkspaceDir: active.remoteWorkspaceDir,
      manifestRef: MANIFEST_REF,
    }));
    const handle = await tunnels.start({
      environmentId,
      ownerEpoch: attached.ownerEpoch,
      deviceId: attached.nodeDeviceId!,
      sessionId: active.sessionId,
      executionMode: "worker-turn",
      expectedBuild: build,
    });
    // Keep transfer/apply outside this lifecycle proof; the real tunnel owns quiescence
    // and its captured authority, and the real provider lifecycle fences that owner.
    const workspace = await harness.environments.startTunnel({
      environmentId,
      ownerEpoch: attached.ownerEpoch,
    });
    handle.reconcileWorkspace = vi.fn(workspace.reconcileWorkspace.bind(workspace));
    const reconciliationError = new Error("workspace transfer interrupted");
    let closingOwner: Promise<unknown> | undefined;
    if (failure === "reconciliation" || failure === "resume-owner-close") {
      vi.mocked(handle.reconcileWorkspace).mockImplementationOnce(async () => {
        if (failure === "resume-owner-close") {
          transport.listCurrentNodes = async () => {
            transport.listCurrentNodes = async () => nodes;
            closingOwner = service.destroy(environmentId);
            await closingOwner;
            return nodes;
          };
        }
        throw reconciliationError;
      });
    }
    const providerPending = createDeferred();
    const destroyStarted = createDeferred();
    const destroy = vi.fn(async () => {});
    if (failure !== "reconciliation" && failure !== "resume-owner-close") {
      destroy.mockImplementationOnce(async () => {
        destroyStarted.resolve();
        if (failure === "timeout") {
          await providerPending.promise;
        } else {
          throw new Error("provider destruction is indeterminate");
        }
      });
    }
    const service = support.createService(
      support.createProvider({ supportedExecutionModes: ["worker-turn"], destroy }),
      { nodeTunnelManager: tunnels, providerCallTimeoutMs: 1_000 },
    );
    let primaryError: unknown;
    vi.mocked(harness.environments.get).mockImplementation(service.get);
    vi.mocked(harness.environments.startTunnel).mockImplementation(async (request) => {
      await service.startTunnel(request);
      return handle;
    });
    vi.mocked(harness.environments.stopTunnel).mockImplementation(service.stopTunnel);
    vi.mocked(harness.environments.reconcileOnce).mockImplementation(service.reconcileOnce);
    vi.mocked(harness.environments.destroy).mockImplementation(async (id) => {
      try {
        return await service.destroy(id);
      } catch (error) {
        primaryError = error;
        expect(environments.get(id)).toMatchObject({
          state: "attached",
          attachedSessionIds: [active.sessionId],
          ownerEpoch: attached.ownerEpoch,
          destroyRequestedAtMs: support.testState.nowMs,
        });
        expect(environments.getCredential(id)).toBeUndefined();
        expect(tunnels.status(id)).toBe("stopped");
        providerPending.resolve();
        throw error;
      }
    });
    const coordinated = coordinateWorkerPlacementDispatch(harness.service, (_request, run) =>
      run(),
    );
    invoke.mockClear();
    vi.mocked(harness.environments.startTunnel).mockClear();
    // SQLite workers compare cross-thread monotonic deadlines; fake only the provider timer.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = (
      operation === "recovery"
        ? coordinated.reconcileActive()
        : operation === "reclaim"
          ? coordinated.reclaim(REQUEST)
          : coordinated.move({
              ...REQUEST,
              source: placementSource(active),
              target: { kind: "gateway" },
            })
    ).catch((error: unknown) => error);
    try {
      if (failure === "resume-owner-close") {
        const outcome = await result;
        expect(closingOwner).toBeDefined();
        await closingOwner;
        expect.soft(outcome).toBe(reconciliationError);
        expect(destroy).toHaveBeenCalledOnce();
        expect(tunnels.status(environmentId)).toBe("stopped");
        expect(service.get(environmentId)?.state).toBe("destroyed");
        expect(releaseCalls()).toEqual([]);
        return;
      }
      if (failure === "reconciliation") {
        expect(await result).toBe(reconciliationError);
        expect(destroy).not.toHaveBeenCalled();
        expect(tunnels.status(environmentId)).toBe("connected");
        expect(placements.get(active.sessionId)).toMatchObject({
          state: "draining",
          turnClaim: null,
        });
        expect(releaseCalls()).toHaveLength(1);
        await expect(coordinated.reclaim(REQUEST)).resolves.toMatchObject({
          state: "reclaimed",
        });
        return;
      }
      await Promise.race([
        destroyStarted.promise,
        result.then((outcome) => {
          throw outcome;
        }),
      ]);
      if (failure === "timeout") {
        await vi.advanceTimersByTimeAsync(1_001);
      }
      const outcome = await result;
      const expectedError =
        failure === "timeout"
          ? "Worker provider operation timed out after 1000ms"
          : "provider destruction is indeterminate";
      expect(primaryError).toMatchObject({ code: "provider_failure", message: expectedError });
      if (operation === "recovery") {
        expect(outcome).toBeUndefined();
        expect
          .soft(harness.reportWorkspaceResultRecoveryFailure)
          .toHaveBeenCalledWith(expect.objectContaining({ error: expectedError }));
      } else {
        expect.soft(outcome).toBe(primaryError);
      }
      expect(placements.get(active.sessionId)?.state).toBe("draining");
      expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([
        expect.objectContaining({ workspaceAcceptedAtMs: expect.any(Number) }),
      ]);
      expect(destroy).toHaveBeenCalledOnce();
      await coordinated.reconcileActive();
      expect(placements.get(active.sessionId)).toMatchObject({
        state: operation === "move" ? "local" : "reclaimed",
        generation: active.generation + 3,
        turnClaim: null,
        recoveryError: null,
      });
      expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
      expect(service.get(environmentId)?.state).toBe("destroyed");
      expect(destroy).toHaveBeenCalledTimes(2);
      expect(harness.environments.startTunnel).toHaveBeenCalledOnce();
      expect(releaseCalls()).toEqual([]);
    } finally {
      providerPending.resolve();
      vi.useRealTimers();
      await closingOwner;
    }
  },
);

it.each(["reclaim", "move", "idle suspend"] as const)(
  "SSH %s reconciles before releasing its expired lease",
  async (operation) => {
    const { stateDb: database, root } = support.testState;
    const placements = createWorkerSessionPlacementStore({
      database,
      now: () => support.testState.nowMs,
    });
    const harness = await createHarness(database, placements, {
      workspacePath: root,
    });
    const environmentId = harness.ready.environmentId;
    const identity = await support.seedAttachedIdentity(environmentId, REQUEST.sessionId);
    const active = await seedActivePlacement(placements, {
      environmentId,
      ownerEpoch: identity.ownerEpoch,
      executionMode: "remote-exec",
    });
    if (active.state !== "active") {
      throw new Error("expected active SSH placement");
    }
    await harness.environments.attachSession({
      environmentId,
      ownerEpoch: harness.ready.ownerEpoch,
      sessionId: REQUEST.sessionId,
    });
    const workspace = await harness.environments.startTunnel({
      environmentId,
      ownerEpoch: identity.ownerEpoch,
    });
    const reconcileWorkspace = vi.spyOn(workspace, "reconcileWorkspace");
    const tunnelManager = {
      status: () => "connected" as const,
      start: vi.fn(async () => workspace),
      stop: vi.fn(async () => {}),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const destroy = vi.fn(async () => {
      expect(reconcileWorkspace).toHaveBeenCalledOnce();
    });
    const service = support.createService(support.createProvider({ destroy }), { tunnelManager });
    vi.mocked(harness.environments.get).mockImplementation(service.get);
    vi.mocked(harness.environments.startTunnel).mockImplementation(service.startTunnel);
    vi.mocked(harness.environments.stopTunnel).mockImplementation(service.stopTunnel);
    vi.mocked(harness.environments.destroy).mockImplementation(service.destroy);
    support.testState.nowMs = identity.credentialExpiresAtMs + 60_001;

    if (operation === "move") {
      await harness.service.move({
        ...REQUEST,
        source: placementSource(active),
        target: { kind: "gateway" },
      });
    } else if (operation === "idle suspend") {
      using clock = vi.spyOn(Date, "now");
      clock.mockImplementation(() => support.testState.nowMs);
      support.getDevelopmentProfile().suspendAfter = "1m";
      const warn = vi.fn();
      await createWorkerPlacementIdleSweep({
        placements,
        environments: service,
        dispatch: harness.service,
        reportChanges: (sweep) => sweep(),
        getConfig: () => support.testState.config,
        info: vi.fn(),
        warn,
      }).sweep();
      expect(warn).not.toHaveBeenCalled();
    } else {
      await harness.service.reclaim(REQUEST);
    }

    expect(destroy).toHaveBeenCalledOnce();
    expect(service.get(environmentId)?.state).toBe("destroyed");
    expect(placements.get(active.sessionId)).toMatchObject({
      state: operation === "move" ? "local" : "reclaimed",
      turnClaim: null,
    });
    expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
  },
);
