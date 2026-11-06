import { expect, it, onTestFinished, vi } from "vitest";
import { NODE_WORKER_WORKSPACE_EXEC_COMMAND } from "../../infra/node-commands.js";
import {
  NODE_WORKSPACE_PUBLICATION_CONFLICT_CODE,
  NodeWorkerPublicationConflictError,
} from "../../worker/node-workspace-transfer-protocol.js";
import {
  createManager,
  environment as tunnelEnvironment,
  startRequest,
  transport,
  withWorkspaceDrain,
  workspaceSnapshot,
  workspaceTransfer,
} from "./node-worker-tunnel.test-support.js";
import {
  createDispatchEnvironmentFixtures,
  REQUEST,
  seedActivePlacement,
} from "./placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { seedAttachedPlacementEnvironment } from "./placement-test-fixtures.js";
import { createRepositoryPublicationPreparation } from "./repository-publication-preparation.js";
import { setupWorkerEnvironmentServiceSuite, testState } from "./service.test-support.js";
import { WorkerTunnelOwnerDisconnectedError } from "./tunnel-contract.js";
import { createWorkerTurnTunnel } from "./worker-turn-launcher.test-support.js";

setupWorkerEnvironmentServiceSuite();

it.each([false, true])(
  "admits retained compute before reconnect and rechecks authority (revoked: %s)",
  async (revoke) => {
    const placements = createWorkerSessionPlacementStore({ database: testState.stateDb });
    const { attached } = createDispatchEnvironmentFixtures();
    const environment = {
      ...attached,
      retention: {
        policy: { version: 1 as const, ownerBinding: REQUEST.sessionId, computeWindowSeconds: 600 },
        runtimeReady: false,
        operation: null,
        observation: null,
      },
    };
    seedAttachedPlacementEnvironment(testState.stateDb, {
      environmentId: environment.environmentId,
      ownerEpoch: environment.ownerEpoch,
      sessionId: REQUEST.sessionId,
    });
    await seedActivePlacement(placements, {
      environmentId: environment.environmentId,
      ownerEpoch: environment.ownerEpoch,
    });
    let current = true;
    const events: string[] = [];
    const assertCurrent = () => {
      if (!current) {
        throw new Error("request revoked");
      }
    };
    const readNativeCredential = Object.assign(async () => "synthetic-token", {
      admit: async () => {
        events.push("admit");
      },
      assertCurrent,
    });
    const result = {
      snapshotRoot: "/fixture",
      snapshot: {
        version: 1 as const,
        baseCommit: "a".repeat(40),
        baseTree: "b".repeat(40),
        workspaceTree: "c".repeat(40),
        entries: [],
      },
      release: async () => {},
    };
    const launchTurn = vi.fn();
    const tunnel = createWorkerTurnTunnel({
      launchTurn,
      reconcileWorkspace: vi.fn(),
      integratePublication: async (input) => {
        input.assertCurrent();
        events.push("integrate");
        return result;
      },
    });
    const startTunnel = vi
      .fn()
      .mockRejectedValueOnce(new WorkerTunnelOwnerDisconnectedError())
      .mockResolvedValue(tunnel);
    const ensurePlacement = vi.fn(async () => {
      throw new Error("unexpected provisioning");
    });
    const prepare = createRepositoryPublicationPreparation({
      placements,
      ensurePlacement,
      getConfig: () => testState.config,
      resolveDevicePlacementRequirement: async () => {
        throw new Error("unexpected device selection");
      },
      environments: {
        get: () => environment,
        startTunnel,
        inspectTurnLease: async (input) => {
          input.assertCurrent();
          events.push("compute");
          current = !revoke;
        },
      },
      waitForNode: async (input) => {
        input.assertCurrent();
        events.push("reconnect");
      },
      reconcileActive: async () => {
        events.push("reconcile");
      },
    });
    const pending = prepare(REQUEST, {
      snapshotRoot: "/fixture",
      snapshotDigest: `sha256:${"a".repeat(64)}`,
      sourceUrl: "https://github.com/owner/repository.git",
      targetUrl: "https://github.com/owner/repository.git",
      targetCommit: "a".repeat(40),
      token: "synthetic-token",
      readNativeCredential,
      assertCurrent,
    });
    if (revoke) {
      await expect(pending).rejects.toThrow("request revoked");
      expect(events).toEqual(["admit", "compute"]);
      expect(startTunnel).toHaveBeenCalledOnce();
    } else {
      expect(await pending).toBe(result);
      expect(events).toEqual(["admit", "compute", "reconnect", "reconcile", "integrate"]);
      expect(startTunnel).toHaveBeenCalledTimes(2);
    }
    expect(ensurePlacement).not.toHaveBeenCalled();
    expect(launchTurn).not.toHaveBeenCalled();
  },
);

it("preserves a worker publication conflict across the node tunnel boundary", async () => {
  const node = transport();
  const invoke = node.invoke.bind(node);
  node.invoke = withWorkspaceDrain(async (request) =>
    request.command === NODE_WORKER_WORKSPACE_EXEC_COMMAND
      ? {
          ok: false,
          error: {
            code: NODE_WORKSPACE_PUBLICATION_CONFLICT_CODE,
            message: "private conflict details",
          },
        }
      : await invoke(request),
  );
  const snapshot = workspaceSnapshot("/gateway/workspace");
  const manager = createManager(tunnelEnvironment(), {
    getTransport: () => node,
    workspaceTransfer: workspaceTransfer({
      prepareSync: vi.fn(async () => ({ snapshot, token: "restore-token" })),
      closeAll: async () => {},
    }),
  });
  onTestFinished(() => manager.stopAll());
  manager.bindWorkspaceBindingResolver(async () => ({
    source: { kind: "local", path: snapshot.root },
    manifestRef: snapshot.manifestRef,
    remoteWorkspaceDir: "/node/workspace",
  }));
  const handle = await manager.start(startRequest());
  await expect(
    handle.runWorkspaceCommand({ argv: ["publication"], transportRetry: "never" }),
  ).rejects.toBeInstanceOf(NodeWorkerPublicationConflictError);
});
