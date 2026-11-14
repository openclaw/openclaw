import { afterEach, expect, it, vi } from "vitest";
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
const DEVICE_TARGET = { kind: "device", deviceId: "paired-build-mac" } as const;

it.each<[WorkerPlacementMoveTarget, boolean, string]>([
  [DEVICE_TARGET, true, "source placement barrier started"],
  [DEVICE_TARGET, false, "runtime codex does not support paired-device placement"],
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
  "validates worker move destination %j (device-capable runtime: %s)",
  (target, supported, expectedError) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionId = "session-move-source";
      const source = { generation: 4, environmentId: "environment-source", ownerEpoch: 2 };
      const worktree = { id: "worktree-recovery", ownerId: SESSION_KEY, path: state.root };
      const entry = {
        sessionId,
        worktree: { id: worktree.id, branch: "recovery", repoRoot: worktree.path },
      };
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
      const environments = {
        supportsExecutionMode: (profileId: string) => profileId === "compatible",
      };
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
                findLiveByOwner: async () => worktree,
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
      const mutate = vi.fn();
      const moves = createWorkerPlacementMoveService({
        placements: {
          getPlacementMoveAsync: async () => undefined,
          beginPlacementMove: mutate,
        } as never,
        environments: { get: () => undefined, destroy: mutate } as never,
        runMoveBarrier,
        dispatch: mutate,
        reclaimSource: mutate,
        validateAbandonSource: vi.fn(),
        abandonSource: vi.fn(),
        resolveDestination,
      });

      await expect(
        moves.move({
          sessionId,
          sessionKey: SESSION_KEY,
          agentId: "main",
          source,
          target,
        }),
      ).rejects.toThrow(expectedError);

      expect(runMoveBarrier).toHaveBeenCalledTimes(Number(supported));
      expect(mutate).not.toHaveBeenCalled();
      if (supported) {
        await expect(resolveDestination.mock.results[0]?.value).resolves.toMatchObject({
          executionMode: "remote-exec",
          devicePlacement: DEVICE_REQUIREMENT,
          ...(target.kind === "profile"
            ? { machineClass: target.machineClass, os: target.os }
            : {}),
        });
      }
    }),
);
