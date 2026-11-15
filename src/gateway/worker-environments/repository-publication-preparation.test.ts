import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it, onTestFinished, vi } from "vitest";
import { NODE_WORKER_WORKSPACE_EXEC_COMMAND } from "../../infra/node-commands.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
} from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  NODE_WORKSPACE_PUBLICATION_CONFLICT_CODE,
  NodeWorkerPublicationConflictError,
} from "../../worker/node-workspace-transfer-protocol.js";
import { registerPublicationCredentialFixture } from "../github-publication-credential.test-helpers.js";
import {
  createNodeRunnerStatePublisher,
  waitForNodeRunnerAvailability,
} from "../node-runner-inventory-runtime.js";
import { assertRepositoryDispatchAdmission } from "../repository-dispatch.js";
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
import {
  seedAttachedPlacementEnvironment,
  writePlacementEnvironmentFixture,
} from "./placement-test-fixtures.js";
import { createRepositoryPublicationPreparation } from "./repository-publication-preparation.js";
import type { WorkerPlacementDispatchContract } from "./service-contract.js";
import { setupWorkerEnvironmentServiceSuite, testState } from "./service.test-support.js";
import { ensureWorkerSessionPlacement } from "./session-placement-lifecycle.js";
import { WorkerTunnelOwnerDisconnectedError } from "./tunnel-contract.js";
import { createWorkerPlacementRedispatch } from "./worker-placement-redispatch.js";
import { createWorkerTurnTunnel } from "./worker-turn-launcher.test-support.js";

setupWorkerEnvironmentServiceSuite();

// Real publication preparation, placement persistence, recovery and admission;
// the provider/transport and credential issuer are synthetic, with no model turn.
it.each(["allowed", "revoked", "cancelled"] as const)(
  "recovers publication with its invocation reader (mode: %s)",
  async (mode) => {
    const revoke = mode === "revoked";
    const abort = new AbortController();
    const registry = captureActivePluginRegistrySnapshot();
    onTestFinished(() => restoreActivePluginRegistrySnapshot(registry));
    const events: string[] = [];
    testState.config.gateway = {};
    registerPublicationCredentialFixture({ config: testState.config }, events);
    const placements = createWorkerSessionPlacementStore({ database: testState.stateDb });
    const { attached } = createDispatchEnvironmentFixtures();
    writePlacementEnvironmentFixture(testState.stateDb, attached);
    const active = await seedActivePlacement(placements, {
      environmentId: attached.environmentId,
      ownerEpoch: attached.ownerEpoch,
    });
    const owner = {
      sessionId: active.sessionId,
      environmentId: attached.environmentId,
      ownerEpoch: attached.ownerEpoch,
    };
    const draining = await placements.startDrain({
      ...owner,
      expectedGeneration: active.generation,
    });
    const reconciling = await placements.startReconcile({
      ...owner,
      expectedGeneration: draining.generation,
    });
    const reclaimed = await placements.transition({
      sessionId: active.sessionId,
      from: "reconciling",
      to: "reclaimed",
      expectedGeneration: reconciling.generation,
    });
    writePlacementEnvironmentFixture(testState.stateDb, {
      ...attached,
      state: "destroyed",
      attachedSessionIds: [],
    });
    let readerCurrent = true;
    const assertReaderCurrent = () => {
      if (!readerCurrent) {
        throw new Error("publication dispatch reader revoked");
      }
    };
    const readNativeCredential = Object.assign(
      async () => {
        assertReaderCurrent();
        return "synthetic-dispatch-credential";
      },
      {
        assertCurrent: assertReaderCurrent,
        admit: async () => {
          assertReaderCurrent();
          events.push("admitted");
        },
      },
    );
    const dispatch: WorkerPlacementDispatchContract["dispatch"] = async (
      request,
      _transition,
      assertCurrent,
    ) => {
      assertCurrent?.();
      assertRepositoryDispatchAdmission(request.readNativeCredential, testState.config);
      await request.readNativeCredential?.admit?.();
      events.push("provision");
      writePlacementEnvironmentFixture(testState.stateDb, attached);
      const recovered = await seedActivePlacement(placements, {
        environmentId: attached.environmentId,
        ownerEpoch: attached.ownerEpoch,
      });
      if (recovered.state !== "active") {
        throw new Error("expected active fixture");
      }
      return recovered;
    };
    const redispatchPlacement = createWorkerPlacementRedispatch({
      placements: {
        readProjection: async (...args) => {
          const projection = await placements.readProjection(...args);
          readerCurrent = !revoke;
          if (mode === "cancelled") {
            abort.abort(new Error("publication cancelled"));
          }
          return projection;
        },
      },
      dispatch,
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
    const unexpected = async (): Promise<never> => {
      throw new Error("unexpected fresh placement or turn");
    };
    const tunnel = createWorkerTurnTunnel({
      launchTurn: unexpected,
      reconcileWorkspace: unexpected,
      integratePublication: async (input) => {
        input.assertCurrent();
        events.push("integrate");
        return result;
      },
    });
    const prepare = createRepositoryPublicationPreparation({
      placements,
      ensurePlacement: (input) =>
        ensureWorkerSessionPlacement({
          ...input,
          placements,
          environments: { get: () => attached },
          redispatchPlacement,
          dispatch: unexpected,
          startDispatch: unexpected,
          waitForInitialPlacement: unexpected,
        }),
      getConfig: () => testState.config,
      resolveDevicePlacementRequirement: unexpected,
      environments: {
        get: () => attached,
        startTunnel: async () => tunnel,
        inspectTurnLease: unexpected,
      },
      waitForNode: unexpected,
      reconcileActive: unexpected,
    });
    const pending = prepare(REQUEST, {
      snapshotRoot: "/fixture",
      snapshotDigest: `sha256:${"a".repeat(64)}`,
      sourceUrl: "https://github.com/owner/repository.git",
      targetUrl: "https://github.com/owner/repository.git",
      targetCommit: "a".repeat(40),
      token: "synthetic-execution-credential",
      signal: abort.signal,
      readNativeCredential,
      assertCurrent: () => {},
    });
    if (mode !== "allowed") {
      await expect(pending).rejects.toThrow(
        revoke ? "publication dispatch reader revoked" : "publication cancelled",
      );
      expect(events).toEqual([]);
      expect(placements.get(REQUEST.sessionId)).toEqual(reclaimed);
    } else {
      expect(await pending).toBe(result);
      expect(events).toEqual(["admitted", "provision", "integrate"]);
      expect(placements.get(REQUEST.sessionId)).toMatchObject({
        state: "active",
        sessionId: reclaimed.sessionId,
        sessionKey: reclaimed.sessionKey,
      });
    }
  },
);

it.each(["allowed", "revoked", "cancelled"] as const)(
  "admits retained compute before reconnect and rechecks authority (mode: %s)",
  async (mode) => {
    const revoke = mode === "revoked";
    const abort = new AbortController();
    const cleanup = new AbortController();
    const entered = createDeferredCore();
    const publisher = createNodeRunnerStatePublisher(() => undefined, new Map());
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
        if (mode === "cancelled") {
          await waitForNodeRunnerAvailability(
            publisher,
            {
              getCurrentNode: async () => {
                entered.resolve();
                return undefined;
              },
              isCurrent: () => false,
            },
            "offline-publication-worker",
            {
              assertCurrent: input.assertCurrent,
              signal: AbortSignal.any([input.signal, cleanup.signal]),
            },
          );
        }
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
      signal: abort.signal,
      readNativeCredential,
      assertCurrent,
    });
    if (mode === "cancelled") {
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        await entered.promise;
        await nextTurn();
        expect(settled).toBe(false);
        abort.abort(new Error("publication cancelled"));
        await nextTurn();
        expect(settled).toBe(true);
        await expect(pending).rejects.toMatchObject({
          name: "AbortError",
          cause: abort.signal.reason,
        });
        expect(events).toEqual(["admit", "compute", "reconnect"]);
        expect(startTunnel).toHaveBeenCalledOnce();
      } finally {
        cleanup.abort();
        await pending.catch(() => {});
      }
    } else if (revoke) {
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
