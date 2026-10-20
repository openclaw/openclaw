import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayWorkerPlacementMoveDestinationResolver } from "./server-worker-placement-move-destination.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";
import { bindDeviceWorkerAvailability } from "./worker-environments/device-provider.js";
import { createNodeWorkerBundleTestNode } from "./worker-environments/node-worker-bundle.test-support.js";
import type { WorkerPlacementMoveTarget } from "./worker-environments/placement-move-intent.types.js";
import { createWorkerPlacementMoveService } from "./worker-environments/placement-move-service.js";

afterEach(clearRuntimeConfigSnapshot);

const SESSION_KEY = "agent:main:move-source";
const CODEX_COMMAND = "codex.exec-server.stdio.v1";
const DEVICE_REQUIREMENT = { requiredNodeCommands: [CODEX_COMMAND], consumesWorkerSlot: false };

describe("worker placement move destination owner", () => {
  it.each<[WorkerPlacementMoveTarget, boolean, string]>([
    [{ kind: "device", deviceId: "paired-build-mac" }, true, "source placement barrier started"],
    [
      { kind: "device", deviceId: "paired-build-mac" },
      false,
      "runtime codex does not support paired-device placement",
    ],
    [
      { kind: "profile", profileId: "incompatible" },
      false,
      "worker profile incompatible does not support remote-exec placement",
    ],
    [
      { kind: "profile", profileId: "compatible", machineClass: "tiny", os: "os-a" },
      true,
      "source placement barrier started",
    ],
  ])(
    "validates destination %j (device-capable runtime: %s)",
    async (target, supported, expectedError) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const source = Object.freeze({
          sessionId: "session-move-source",
          state: "active",
          generation: 4,
          environmentId: "environment-source",
          activeOwnerEpoch: 2,
          executionMode: "remote-exec",
        });
        const sourceBefore = JSON.stringify(source);
        const worktree = {
          id: "worktree-recovery",
          branch: "recovery",
          repoRoot: "/gateway/workspace",
        };
        const entry = { sessionId: source.sessionId, worktree };
        const config = {
          session: { store: state.path("sessions.sqlite") },
          cloudWorkers: {
            profiles: {
              compatible: { provider: "multimode-cloud" },
              incompatible: { provider: "worker-only" },
            },
          },
          gateway: { nodes: { commands: { allow: [CODEX_COMMAND] } } },
        };
        setRuntimeConfigSnapshot(config);
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: SESSION_KEY, storePath: config.session.store },
          entry,
        );
        const supportsExecutionMode = vi.fn((profileId: string) => profileId === "compatible");
        const environments = { supportsExecutionMode };
        bindDeviceWorkerAvailability(environments, async (deviceId) => ({
          available: true,
          node: {
            ...createNodeWorkerBundleTestNode(),
            nodeId: deviceId,
            workerHost: { enabled: true, capacity: { total: 2, available: 0 } },
            commands: [CODEX_COMMAND],
          },
        }));
        const resolveDestination = vi.fn(
          createGatewayWorkerPlacementMoveDestinationResolver({
            environments: environments as never,
            getConfig: () => config,
            loadSessionRuntime: async () =>
              ({
                managedWorktrees: {
                  findLiveByOwner: async () => ({
                    id: worktree.id,
                    ownerId: SESSION_KEY,
                    path: worktree.repoRoot,
                  }),
                },
                resolveGatewaySessionStoreTargetInWorker,
                resolveCanonicalSessionEntryFromStoreKeys: () => entry,
                resolveWorkerPlacementSessionRuntimeAsync: async () => "codex",
                resolveWorkerPlacementCapabilities: () => ({
                  executionMode: "remote-exec",
                  ...(supported ? { devicePlacement: DEVICE_REQUIREMENT } : {}),
                }),
              }) as never,
          }),
        );
        const runMoveBarrier = vi.fn(async () => {
          throw new Error("source placement barrier started");
        });
        const mutations = {
          reclaimSource: vi.fn(),
          dispatch: vi.fn(),
          beginPlacementMove: vi.fn(),
          destroy: vi.fn(),
        };
        const moves = createWorkerPlacementMoveService({
          placements: {
            getAsync: async () => source,
            getPlacementMoveAsync: async () => undefined,
            beginPlacementMove: mutations.beginPlacementMove,
          } as never,
          environments: { get: () => undefined, destroy: mutations.destroy } as never,
          runMoveBarrier,
          dispatch: mutations.dispatch,
          reclaimSource: mutations.reclaimSource,
          validateAbandonSource: vi.fn(),
          abandonSource: vi.fn(),
          resolveDestination,
        });

        await expect(
          moves.move({
            sessionId: source.sessionId,
            sessionKey: SESSION_KEY,
            agentId: "main",
            source: {
              generation: source.generation,
              environmentId: source.environmentId,
              ownerEpoch: source.activeOwnerEpoch,
            },
            target,
          }),
        ).rejects.toThrow(expectedError);

        expect(runMoveBarrier).toHaveBeenCalledTimes(Number(supported));
        for (const mutation of Object.values(mutations)) {
          expect(mutation).not.toHaveBeenCalled();
        }
        expect(JSON.stringify(source)).toBe(sourceBefore);
        if (supported) {
          await expect(resolveDestination.mock.results[0]?.value).resolves.toMatchObject({
            executionMode: "remote-exec",
            devicePlacement: DEVICE_REQUIREMENT,
            ...(target.kind === "profile"
              ? { machineClass: target.machineClass, os: target.os }
              : {}),
          });
        }
        if (target.kind === "profile") {
          expect(supportsExecutionMode).toHaveBeenCalledWith(target.profileId, "remote-exec");
        }
      });
    },
  );
});
