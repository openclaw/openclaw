import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
  NODE_WORKER_WORKSPACE_EXEC_COMMAND,
} from "../../infra/node-commands.js";
import { NODE_WORKSPACE_DRAIN_COMMAND } from "../../worker/node-workspace-protocol.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import * as nodeSupport from "./node-worker-tunnel.test-support.js";
import { REQUEST, seedActivePlacement } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { FORCED_WORKER_ABANDONMENT_ERROR } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { placementClaim, placementSource } from "./placement-suite.test-support.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";

support.setupWorkerEnvironmentServiceSuite();

it.each([
  { cleanup: "complete", sharedHost: true },
  { cleanup: "held", sharedHost: true },
  { cleanup: "failed", sharedHost: true },
  { cleanup: "restarted", sharedHost: true },
  { cleanup: "replacement-restarted", sharedHost: true },
  { cleanup: "authorization-closed", sharedHost: true },
  { cleanup: "retired-siblings", sharedHost: true },
  { cleanup: "retired-mixed", sharedHost: true },
  { cleanup: "replacement-restarted", sharedHost: null },
] as const)(
  "fences the old claim and retains exact cleanup ownership with $cleanup sibling cleanup and sharedHost=$sharedHost",
  async ({ cleanup, sharedHost }) => {
    const state = support.testState;
    let placements = createWorkerSessionPlacementStore({ database: state.stateDb });
    const harness = await createHarness(state.stateDb, placements, { workspacePath: state.root });
    const environmentId = harness.ready.environmentId;
    const deviceId = "paired-device";
    const build = {
      ...support.BOOTSTRAP_RECEIPT,
      protocolFeatures: [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE],
    };
    state.prepareInstallation = async () => ({
      ...support.BUNDLE_ARTIFACT,
      ...build,
    });
    async function seedDevice(id: string, isolation: boolean | null = true) {
      await state.store.createIntent({
        environmentId: id,
        providerId: "device",
        profileId: `device:${deviceId}`,
        profileSnapshot: { settings: { device: deviceId }, executionMode: "worker-turn" },
        provisionOperationId: `provision:${id}`,
      });
      await state.store.transition({
        environmentId: id,
        from: "requested",
        to: "provisioning",
      });
      await state.store.transition({
        environmentId: id,
        from: "provisioning",
        to: "ready",
        patch: {
          ...support.readyPatch(id, { ...build, installKind: "bundle" }),
          leaseId: `lease:${id}`,
          nodeDeviceId: deviceId,
          ...(isolation === null ? {} : { sharedHost: isolation }),
        },
      });
    }
    await seedDevice(environmentId, sharedHost);
    const attach = (id: string) =>
      state.store.transition({
        environmentId: id,
        from: "ready",
        to: "attached",
        patch: support.attachedPatch(id, REQUEST.sessionId),
      });
    const attached = await attach(environmentId);
    expect(attached.sharedHost).toBe(sharedHost);
    const active = await harness.placements.seedActive(attached.ownerEpoch);
    if (active.state !== "active") {
      throw new Error("expected active placement");
    }
    const claim = await placements.claimTurn(placementClaim(active, "abandoned"));
    await placements.authorizeWorkerTurnTools(claim, ["sessions_send"]);
    const expectClaimRevoked = () => {
      expect([
        placements.validateTurnClaim(claim),
        placements.isWorkerTurnToolAuthorized(claim, "sessions_send"),
        placements.validateWorkspaceResultClaim(claim),
      ]).toEqual([false, false, false]);
    };
    const replacementId = "worker-replacement";
    await seedDevice(replacementId);
    const attachReplacement = () => attach(replacementId);
    await expect(attachReplacement()).rejects.toThrow("already attached");
    const transport = nodeSupport.transport();
    const connectedNodes = await transport.listCurrentNodes();
    connectedNodes[0]!.nodeId = deviceId;
    const listNodes = vi.fn<typeof transport.listCurrentNodes>(async () => connectedNodes);
    transport.listCurrentNodes = listNodes;
    const invoke = vi.fn(transport.invoke.bind(transport));
    transport.invoke = invoke;
    const transfer = { ...nodeSupport.workspaceTransfer(), closeAll: vi.fn(async () => {}) };
    const createTunnels = () =>
      createNodeWorkerTunnelManager({
        gatewayDeviceId: "gateway-fixture",
        getEnvironment: (id) => state.store.get(id),
        listEnvironments: () => state.store.list(),
        getTransport: () => transport,
        launchNodeWorker: vi.fn(),
        validateWorkerTurn: (candidate) => placements.validateTurnClaim(candidate),
        workspaceTransfer: transfer,
      });
    let tunnels = createTunnels();
    const startTunnel = (targetEnvironmentId: string, ownerEpoch: number) =>
      tunnels.start({
        environmentId: targetEnvironmentId,
        ownerEpoch,
        deviceId,
        sessionId: active.sessionId,
        executionMode: "worker-turn",
        expectedBuild: build,
      });
    const destroy = vi.fn(async () => {});
    const cleanupStarted = createDeferred();
    const releaseCleanup = createDeferred();
    const cleanupFailure = new Error("desktop carrier cleanup failed");
    const stopDesktop = vi.fn(async () => {
      cleanupStarted.resolve();
      if (cleanup !== "complete") {
        await releaseCleanup.promise;
      }
      if (cleanup === "failed") {
        throw cleanupFailure;
      }
    });
    const createService = () =>
      support.createService(
        support.createProvider({
          id: "device",
          supportedExecutionModes: ["worker-turn"],
          inspect: async () => ({ status: "active", sharedHost: true }),
          destroy,
        }),
        {
          nodeTunnelManager: tunnels,
          nodeDesktopCarrier: {
            bindRuntime: vi.fn(),
            launchApp: vi.fn(),
            observe: vi.fn(),
            stop: stopDesktop,
            stopAll: vi.fn(async () => {}),
          },
          placementStore: createWorkerSessionPlacementGate(placements),
        },
      );
    let service = createService();
    const restartDisconnectedService = async () => {
      // Shutdown defers the unreachable node's stop; durable ownership keeps the cleanup.
      await service.stop();
      state.service = undefined;
      await support.reopenWorkerEnvironmentStore();
      placements = createWorkerSessionPlacementStore({ database: state.stateDb });
      tunnels = createTunnels();
      service = createService();
    };
    vi.mocked(harness.environments.get).mockImplementation(service.get);
    vi.mocked(harness.environments.destroy).mockImplementation(service.destroy);
    vi.mocked(harness.environments.stopTunnel).mockImplementation(service.stopTunnel);
    await startTunnel(environmentId, attached.ownerEpoch);
    listNodes.mockResolvedValue([]);

    try {
      const multipleRetired = cleanup === "retired-siblings" || cleanup === "retired-mixed";
      if (multipleRetired) {
        await expect(tunnels.stop(environmentId, attached.ownerEpoch)).rejects.toThrow(
          "not connected",
        );
        await expect(startTunnel(environmentId, attached.ownerEpoch)).rejects.toThrow(
          "not connected",
        );
        // Join the failed replacement's own retirement before testing another stop.
        await expect(tunnels.stop(environmentId, attached.ownerEpoch)).rejects.toThrow();
        if (cleanup === "retired-mixed") {
          vi.mocked(transfer.close).mockRejectedValueOnce(cleanupFailure);
        }
      }
      const credential = state.store.getCredential(environmentId);
      for (const binding of [
        { environmentId, ownerEpoch: attached.ownerEpoch, sessionId: "different-session" },
        { environmentId, ownerEpoch: attached.ownerEpoch + 1, sessionId: active.sessionId },
      ]) {
        await expect(service.destroy(binding.environmentId, binding)).rejects.toThrow(
          "owner changed before retirement",
        );
      }
      expect(state.store.getCredential(environmentId)).toEqual(credential);
      expect(state.store.get(environmentId)?.destroyRequestedAtMs).toBeNull();
      expect(placements.validateTurnClaim(claim)).toBe(true);
      let settled = false;
      let authorized = true;
      const moving = harness.service
        .move(
          {
            ...REQUEST,
            source: placementSource(active),
            target: { kind: "gateway" },
            abandonSource: true,
          },
          undefined,
          () => {
            if (!authorized) {
              throw new Error("session access revoked during cleanup");
            }
          },
        )
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      await Promise.race([cleanupStarted.promise, moving]);
      if (cleanup !== "complete") {
        await setImmediate();
        expect.soft(settled).toBe(false);
      }
      authorized = cleanup !== "authorization-closed";
      releaseCleanup.resolve();
      const outcome = await moving;

      if (cleanup === "authorization-closed") {
        expect(outcome).toMatchObject({ message: "session access revoked during cleanup" });
        expect(placements.get(active.sessionId)?.state).toBe("failed");
      } else if (cleanup === "failed" || cleanup === "retired-mixed") {
        const errors = outcome instanceof AggregateError ? outcome.errors : [outcome];
        expect.soft(errors).toContain(cleanupFailure);
        expect(placements.get(active.sessionId)?.state).toBe("failed");
      } else {
        expect.soft(outcome).toMatchObject({ state: "local", turnClaim: null });
      }
      expectClaimRevoked();
      expect(state.store.getCredential(environmentId)).toBeUndefined();
      await expect(service.acquireTurnCredential(claim)).rejects.toThrow(
        "claim is not authoritative",
      );
      expect(tunnels.status(environmentId)).toBe("stopped");
      expect(state.store.get(environmentId)).toMatchObject({
        state: "attached",
        destroyRequestedAtMs: state.nowMs,
        ownerEpoch: attached.ownerEpoch,
        attachedSessionIds: [active.sessionId],
        nodeDeviceId: deviceId,
        sharedHost,
      });
      expect(invoke).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();

      stopDesktop.mockResolvedValue(undefined);
      if (cleanup === "restarted") {
        await restartDisconnectedService();
      }
      if (cleanup !== "replacement-restarted") {
        listNodes.mockResolvedValue(connectedNodes);
      }
      const replacement =
        cleanup === "failed" || cleanup === "retired-mixed" || cleanup === "authorization-closed"
          ? undefined
          : await attachReplacement();
      let replacementClaim;
      if (replacement) {
        expect(replacement.ownerEpoch).toBeGreaterThan(attached.ownerEpoch);
        await seedActivePlacement(placements, {
          environmentId: replacementId,
          ownerEpoch: replacement.ownerEpoch,
        });
        if (cleanup === "replacement-restarted") {
          // Reopen both owners together, then admit a fresh replacement turn below.
          await restartDisconnectedService();
          listNodes.mockResolvedValue(connectedNodes);
        }
        replacementClaim = await placements.claimTurn(
          placementClaim(
            {
              ...active,
              environmentId: replacementId,
              activeOwnerEpoch: replacement.ownerEpoch,
            },
            "replacement",
          ),
        );
        await placements.authorizeWorkerTurnTools(replacementClaim, ["sessions_send"]);
        const grant = await service.acquireTurnCredential(replacementClaim);
        expect(await service.acknowledgeCredentialDelivery(grant)).toBe(true);
        await startTunnel(replacementId, replacement.ownerEpoch);
      }
      const replacementCredential = state.store.getCredential(replacementId);
      await service.reconcileOnce();
      const count = multipleRetired ? 2 : 1;
      expect(invoke).toHaveBeenCalledTimes(count * 2);
      for (const [command, binding] of [
        [NODE_WORKER_ENVIRONMENT_STOP_COMMAND, { ownerEpoch: attached.ownerEpoch }],
        [
          NODE_WORKER_WORKSPACE_EXEC_COMMAND,
          { generation: attached.ownerEpoch, argv: [NODE_WORKSPACE_DRAIN_COMMAND] },
        ],
      ] as const) {
        const requests = invoke.mock.calls
          .map(([request]) => request)
          .filter((request) => request.command === command);
        expect(requests).toEqual(
          Array.from({ length: count }, () =>
            expect.objectContaining({
              command,
              params: expect.objectContaining({
                environmentId,
                sessionId: active.sessionId,
                ...binding,
              }),
            }),
          ),
        );
      }
      expect(service.get(environmentId)).toMatchObject({
        state: "failed",
        leaseId: null,
        nodeDeviceId: null,
        attachedSessionIds: [],
        lastError: FORCED_WORKER_ABANDONMENT_ERROR,
      });
      expect(destroy).toHaveBeenCalledOnce();
      if (replacement && replacementClaim) {
        expect(state.store.get(replacementId)).toMatchObject({
          state: "attached",
          ownerEpoch: replacement.ownerEpoch,
          attachedSessionIds: [active.sessionId],
          destroyRequestedAtMs: null,
        });
        expect(state.store.getCredential(replacementId)).toEqual(replacementCredential);
        expect({
          tunnel: tunnels.status(replacementId),
          claim: placements.validateTurnClaim(replacementClaim),
          tools: placements.isWorkerTurnToolAuthorized(replacementClaim, "sessions_send"),
        }).toEqual({ tunnel: "connected", claim: true, tools: true });
        expectClaimRevoked();
      }
    } finally {
      releaseCleanup.resolve();
      stopDesktop.mockResolvedValue(undefined);
      listNodes.mockResolvedValue(connectedNodes);
      await service.destroy(environmentId);
      await service.destroy(replacementId);
    }
  },
);
