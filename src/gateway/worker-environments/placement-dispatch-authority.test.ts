import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.native.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import {
  identifiedClient,
  sessionSharingTestContext,
} from "../server-methods/sessions-sharing.test-support.js";
import { resolveSessionMutationAuthorizationAsync } from "../session-sharing-authorization-async.js";
import { bindDeviceWorkerAvailability } from "./device-provider.js";
import { createNodeWorkerBundleTestNode } from "./node-worker-bundle.test-support.js";
import { type PlacementStore, REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerTunnelManager } from "./tunnel.js";
import { fakeRunner, PWD_COMMAND, startTestTunnel, success } from "./tunnel.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cfg = {};
afterEach(() => clearRuntimeConfigSnapshot());

function revocableAuthority(message = "session recovery authority closed") {
  let authorized = true;
  return {
    revoke: () => {
      authorized = false;
    },
    assertCurrent: () => {
      if (!authorized) {
        throw new Error(message);
      }
    },
  };
}

async function waitForEntry(entered: Promise<unknown>, running: Promise<unknown>) {
  await Promise.race([
    entered,
    running.then((error) => {
      throw error;
    }),
  ]);
}

describe("worker placement cancellation and reclaim authority", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let placementStore: PlacementStore;

  const createTestHarness = async (options: Parameters<typeof createHarness>[2] = {}) =>
    await createHarness(database, placementStore, {
      workspacePath: path.join(root, "workspace"),
      ...options,
    });

  beforeEach(async () => {
    setRuntimeConfigSnapshot(cfg);
    root = tempDirs.make("openclaw-reclaim-auth-");
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    placementStore = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each(["requested", "syncing", "starting"] as const)(
    "does not activate after Stop closes the %s dispatch owner",
    async (stage) => {
      const controller = new AbortController();
      const harness = await createTestHarness();
      await expect(
        harness.service.dispatch(
          REQUEST,
          (placement) => {
            if (placement.state === stage) {
              controller.abort(new Error("Stop dispatch"));
            }
          },
          undefined,
          controller.signal,
        ),
      ).rejects.toThrow("Stop dispatch");
      expect(harness.log).not.toContain("activation");
      expect(harness.placements.current()?.state).toBe("failed");
      if (stage === "requested") {
        expect(harness.environments.createWithRequest).not.toHaveBeenCalled();
      } else {
        expect(harness.environments.destroy).toHaveBeenCalledOnce();
      }
    },
  );

  it("aborts held startup workspace sync and joins the SSH owner before teardown", async () => {
    const entered = createDeferredCore();
    const childClosed = createDeferredCore<ReturnType<typeof success>>();
    const controller = new AbortController();
    let ownerSignal: AbortSignal | undefined;
    let knownHostsPath = "";
    const fake = fakeRunner(async (argv, options) => {
      ownerSignal = options.signal;
      knownHostsPath =
        argv
          .find((arg) => arg.startsWith("UserKnownHostsFile="))
          ?.slice("UserKnownHostsFile=".length) ?? "";
      entered.resolve();
      return await childClosed.promise;
    });
    const manager = createWorkerTunnelManager({ runner: fake.runner });
    const harness = await createTestHarness();
    vi.mocked(harness.environments.startTunnel).mockImplementation(
      async ({ environmentId, ownerEpoch }) =>
        await startTestTunnel(manager, environmentId, ownerEpoch),
    );
    vi.mocked(harness.environments.stopTunnel).mockImplementation(manager.stop);
    const settled = vi.fn();
    const dispatching = harness.service
      .dispatch(REQUEST, undefined, undefined, controller.signal)
      .catch((error: unknown) => error)
      .finally(settled);
    try {
      await waitForEntry(entered.promise, dispatching);
      expect(harness.placements.current()?.state).toBe("syncing");
      expect(ownerSignal?.aborted).toBe(false);
      controller.abort(new Error("Stop during workspace sync"));
      await vi.waitFor(() => expect(ownerSignal?.aborted).toBe(true));
      expect(settled).not.toHaveBeenCalled();
      expect(harness.environments.destroy).not.toHaveBeenCalled();
      expect(harness.log).not.toContain("activation");
      await fs.access(knownHostsPath);
    } finally {
      childClosed.resolve({
        ...success(),
        code: null,
        signal: "SIGTERM",
        killed: true,
        termination: "signal",
      });
      await dispatching;
      await manager.stopAll();
    }
    expect(await dispatching).toBeInstanceOf(Error);
    expect(harness.placements.current()?.state).toBe("failed");
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
    expect(harness.log).not.toContain("activation");
    await expect(fs.access(knownHostsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retires startup cancellation while preserving the active reconciliation tunnel", async () => {
    const controller = new AbortController();
    const fake = fakeRunner(() => success("workspace still connected"));
    const manager = createWorkerTunnelManager({ runner: fake.runner });
    const reconciled = vi.fn();
    const harness = await createTestHarness({
      afterReconcile: async () => {
        const command = await handle.runWorkspaceCommand(PWD_COMMAND);
        expect(command.stdout).toBe("workspace still connected");
        reconciled();
      },
    });
    const startFixtureTunnel = vi.mocked(harness.environments.startTunnel).getMockImplementation()!;
    let handle: Awaited<ReturnType<typeof startTestTunnel>>;
    vi.mocked(harness.environments.startTunnel).mockImplementation(async (request) => {
      const fixture = await startFixtureTunnel(request);
      handle = await startTestTunnel(manager, request.environmentId, request.ownerEpoch);
      return {
        ...fixture,
        runWorkspaceCommand: (command) => handle.runWorkspaceCommand(command),
        stop: () => handle.stop(),
      };
    });
    vi.mocked(harness.environments.stopTunnel).mockImplementation(manager.stop);
    try {
      const active = await harness.service.dispatch(
        REQUEST,
        (placement) => {
          if (placement.state === "active") {
            controller.abort(new Error("Stop active worker"));
          }
        },
        undefined,
        controller.signal,
      );
      expect(controller.signal.aborted).toBe(true);
      expect(manager.status(active.environmentId)).toBe("connected");
      expect(harness.environments.stopTunnel).not.toHaveBeenCalled();
      await expect(harness.service.reclaim(REQUEST)).resolves.toMatchObject({ state: "reclaimed" });
      expect(reconciled).toHaveBeenCalledOnce();
      expect(harness.log).toContain("workspace:reconcile");
      expect(harness.environments.destroy).toHaveBeenCalledOnce();
      expect(manager.status(active.environmentId)).toBe("stopped");
    } finally {
      await manager.stopAll();
    }
  });

  it("passes the Move admission signal through destination provisioning", async () => {
    const harness = await createTestHarness();
    const active = await harness.service.dispatch(REQUEST);

    const entered = createDeferredCore();
    const settled = createDeferredCore();
    const controller = new AbortController();
    let provisionSignal: AbortSignal | undefined;
    vi.mocked(harness.environments.createWithRequest).mockImplementation(async ({ signal }) => {
      provisionSignal = signal;
      entered.resolve();
      await settled.promise;
      signal?.throwIfAborted();
      throw new Error("destination unexpectedly finished");
    });
    const moving = harness.service
      .move(
        {
          ...REQUEST,
          source: {
            generation: active.generation,
            environmentId: active.environmentId,
            ownerEpoch: active.activeOwnerEpoch,
          },
          target: { kind: "profile", profileId: "destination" },
        },
        undefined,
        undefined,
        controller.signal,
      )
      .catch((error: unknown) => error);
    await waitForEntry(entered.promise, moving);
    try {
      controller.abort(new Error("Stop Move"));
      expect(provisionSignal?.aborted).toBe(true);
    } finally {
      settled.resolve();
      await moving;
    }
    expect(await moving).toMatchObject({ message: "Stop Move" });
    expect(harness.placements.current()?.state).toBe("failed");
    expect(harness.log.filter((event) => event === "activation")).toHaveLength(1);
  });

  it("stops final effects when authority closes during workspace reconciliation", async () => {
    const authority = revocableAuthority();
    const harness = await createTestHarness({ afterReconcile: authority.revoke });
    await harness.service.dispatch(REQUEST);

    await expect(harness.service.reclaim(REQUEST, authority.assertCurrent)).rejects.toThrow(
      "session recovery authority closed",
    );

    expect(harness.log).toContain("workspace:reconcile");
    expect(harness.log).toContain("workspace:resume");
    expect(harness.log).not.toContain("teardown:destroy");
    expect(harness.log).not.toContain("placement:reclaimed");
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    expect(harness.placements.current()).toMatchObject({ state: "draining" });
  });

  it("finishes durable placement completion when authority closes during destroy", async () => {
    const authority = revocableAuthority();
    const harness = await createTestHarness({ afterDestroy: authority.revoke });
    await harness.service.dispatch(REQUEST);

    await expect(harness.service.reclaim(REQUEST, authority.assertCurrent)).resolves.toMatchObject({
      state: "reclaimed",
    });

    expect(harness.environments.destroy).toHaveBeenCalledOnce();
    expect(harness.placements.current()).toMatchObject({ state: "reclaimed" });
  });

  it("stops failed-placement teardown when authority closes after tunnel cleanup", async () => {
    const authority = revocableAuthority();
    let revokeAfterStop = false;
    const harness = await createTestHarness({
      failAt: "activation",
      destroyFailureCount: 1,
      afterStopTunnel: () => {
        if (revokeAfterStop) {
          authority.revoke();
        }
      },
    });
    await expect(harness.service.dispatch(REQUEST)).rejects.toThrow("activation failed");
    expect(harness.placements.current()).toMatchObject({ state: "failed" });

    revokeAfterStop = true;
    await expect(harness.service.reclaim(REQUEST, authority.assertCurrent)).rejects.toThrow(
      "session recovery authority closed",
    );

    expect(harness.environments.destroy).toHaveBeenCalledTimes(1);
    expect(harness.placements.current()).toMatchObject({ state: "failed" });
  });

  it("finishes failed-placement bookkeeping when authority closes during destroy", async () => {
    let authorized = true;
    const harness = await createTestHarness({
      failAt: "activation",
      destroyFailureCount: 1,
      afterDestroy: () => {
        authorized = false;
      },
    });
    await expect(harness.service.dispatch(REQUEST)).rejects.toThrow("activation failed");
    expect(harness.placements.current()).toMatchObject({ state: "failed" });

    await expect(
      harness.service.reclaim(REQUEST, () => {
        if (!authorized) {
          throw new Error("session recovery authority closed");
        }
      }),
    ).resolves.toMatchObject({ state: "local" });

    expect(harness.environments.destroy).toHaveBeenCalledTimes(2);
    expect(harness.placements.current()).toMatchObject({ state: "local" });
  });
});

describe("worker placement dispatch authority", () => {
  type Harness = Awaited<ReturnType<typeof createHarness>>;
  async function withHarness(run: (harness: Harness, store: PlacementStore) => Promise<void>) {
    await withOpenClawTestState(
      { scenario: "minimal", prepareProfileCatalog: true },
      async (state) => {
        setRuntimeConfigSnapshot(cfg);
        const database = openOpenClawStateDatabase({ env: state.env });
        const store = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
        await run(
          await createHarness(database, store, { workspacePath: state.workspaceDir }),
          store,
        );
      },
    );
  }
  const effects = ["create", "attach", "tunnel:attached", "sync", "placement:starting"];
  const deviceNode: NodeWorkerSupervisorNodeProof = createNodeWorkerBundleTestNode({
    nodeId: "device-1",
    connId: "device-connection-1",
    pairingIdentity: "device-identity-1",
    pairingGeneration: "device-pairing-1",
    workerHost: {
      capturedExecPolicy: true,
      promptContext: 1,
    },
    commands: ["system.run"],
  });
  const deviceRequest = {
    ...REQUEST,
    profileId: "device:device-1",
    deviceId: deviceNode.nodeId,
    devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
  };

  it("stops after requested placement acknowledgment before node readiness", async () => {
    await withHarness(async (harness, store) => {
      const readNodeReadiness = vi.fn(async () => ({ available: true, node: deviceNode }));
      bindDeviceWorkerAvailability(harness.environments, readNodeReadiness);
      const authority = revocableAuthority("session creator authority closed after acknowledgment");

      await expect(
        harness.service.dispatch(
          deviceRequest,
          (placement) => {
            if (placement.state === "requested") {
              authority.revoke();
            }
          },
          authority.assertCurrent,
        ),
      ).rejects.toThrow("session creator authority closed after acknowledgment");

      expect(readNodeReadiness).not.toHaveBeenCalled();
      expect(harness.environments.createWithRequest).not.toHaveBeenCalled();
      expect(store.get(REQUEST.sessionId)).toMatchObject({ state: "failed", turnClaim: null });
    });
  });

  it.each([
    { boundary: "readiness", completedEffects: 0 },
    { boundary: "provisioning", completedEffects: 1 },
    { boundary: "attachment", completedEffects: 2 },
    { boundary: "tunnel", completedEffects: 3 },
    { boundary: "workspace sync", completedEffects: 4 },
    { boundary: "activation", completedEffects: 5 },
  ])(
    "stops after membership revocation during $boundary",
    async ({ boundary, completedEffects }) => {
      await withHarness(async (harness, store) => {
        const scope = { agentId: REQUEST.agentId, sessionKey: REQUEST.sessionKey };
        const owner = ensureProfileForEmail("dispatch-owner@example.test");
        const member = ensureProfileForEmail("dispatch-member@example.test");
        await upsertSessionEntryCore(scope, {
          sessionId: REQUEST.sessionId,
          updatedAt: 1,
          visibility: "read-only",
          createdActor: { type: "human", source: "profile", id: owner.id },
        });
        addSessionMember(scope, {
          identityId: member.id,
          addedBy: owner.id,
          expectedSessionId: REQUEST.sessionId,
        });
        const result = await resolveSessionMutationAuthorizationAsync({
          client: identifiedClient(member.id),
          context: sessionSharingTestContext(vi.fn(), cfg),
          method: "sessions.dispatch",
          requestParams: { key: REQUEST.sessionKey, deviceId: "device-1" },
        });
        using _ = { [Symbol.dispose]: () => result.authorization?.release?.() };
        expect(result.error).toBeNull();
        if (!result.authorization) {
          throw new Error("dispatch fixture did not admit its session member");
        }
        const revokeAt = (phase: string) => {
          if (phase === boundary) {
            expect(
              removeSessionMember(scope, member.id, undefined, REQUEST.sessionId),
            ).not.toBeNull();
          }
        };
        let readinessObserved = false;
        bindDeviceWorkerAvailability(harness.environments, async () => {
          if (!readinessObserved) {
            readinessObserved = true;
            revokeAt("readiness");
          }
          return { available: true, node: deviceNode };
        });
        const create = vi.mocked(harness.environments.createWithRequest).getMockImplementation()!;
        vi.mocked(harness.environments.createWithRequest).mockImplementation(async (request) => {
          const ready = await create(request);
          revokeAt("provisioning");
          return ready;
        });
        const attach = vi.mocked(harness.environments.attachSession).getMockImplementation()!;
        vi.mocked(harness.environments.attachSession).mockImplementation(async (request) => {
          const credential = await attach(request);
          revokeAt("attachment");
          return credential;
        });
        const startTunnel = vi.mocked(harness.environments.startTunnel).getMockImplementation()!;
        vi.mocked(harness.environments.startTunnel).mockImplementation(async (request) => {
          const tunnel = await startTunnel(request);
          const sync = tunnel.syncWorkspace.bind(tunnel);
          tunnel.syncWorkspace = async (syncRequest) => {
            const synced = await sync(syncRequest);
            revokeAt("workspace sync");
            return synced;
          };
          revokeAt("tunnel");
          return tunnel;
        });
        await expect(
          harness.service.dispatch(
            boundary === "readiness" ? deviceRequest : REQUEST,
            (placement) => {
              if (placement.state === "starting") {
                revokeAt("activation");
              }
            },
            result.authorization.assertCurrent,
          ),
        ).rejects.toMatchObject({
          error: { details: { code: "SESSION_PARTICIPATION_REQUIRED" } },
        });

        expect(harness.log.filter((event) => effects.includes(event))).toEqual(
          effects.slice(0, completedEffects),
        );
        expect(harness.log).not.toContain("placement:active");
        expect(harness.environments.destroy).toHaveBeenCalledTimes(completedEffects === 0 ? 0 : 1);
        expect(store.get(REQUEST.sessionId)).toMatchObject({ state: "failed", turnClaim: null });
      });
    },
  );
});
