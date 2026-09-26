import { describe, expect, it, vi } from "vitest";
import { ACTIVE_PLACEMENT } from "./placement-dispatch-coordinator.test-support.js";
import { createDispatchEnvironmentFixtures } from "./placement-dispatch-test-fixtures.js";
import type { WorkerEnvironmentPlacementFacts } from "./placement-read-projection.types.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import { createWorkerPlacementRedispatch } from "./worker-placement-redispatch.js";

const placement = { ...ACTIVE_PLACEMENT, state: "reclaimed" as const };
const dispatchOptions = { assertCurrent: () => {} };
const { ready } = createDispatchEnvironmentFixtures();
const profileSnapshot = {
  machineClass: "large",
  install: "bundle",
  settings: { region: "parent", device: "paired-node" },
} as const;

function reader(
  record: WorkerSessionPlacementRecord,
  environment: WorkerEnvironmentPlacementFacts | undefined,
) {
  return {
    readProjection: async () => ({
      placements: new Map([[record.sessionId, record]]),
      environments: new Map(environment ? [[environment.environmentId, environment]] : []),
      moves: new Map(),
      workspaceResultReconcilingSessionIds: new Set<string>(),
      workspaceRecoveryPendingSessionIds: new Set<string>(),
    }),
  };
}

describe("createWorkerPlacementRedispatch", () => {
  it.each([
    { providerId: "fake", nodeDeviceId: null, executionMode: "worker-turn", state: "reclaimed" },
    {
      providerId: "device",
      nodeDeviceId: "paired-node",
      executionMode: "worker-turn",
      state: "reclaimed",
    },
    {
      providerId: "crabbox",
      nodeDeviceId: "retired-node",
      executionMode: "remote-exec",
      state: "reclaimed",
    },
    {
      providerId: "crabbox",
      nodeDeviceId: "retired-node",
      executionMode: "remote-exec",
      state: "failed",
    },
  ] as const)(
    "preserves the $state $providerId profile and resolves its $executionMode destination",
    async ({ providerId, nodeDeviceId, executionMode, state }) => {
      const profileId = `profile-${providerId}`;
      const environment = {
        ...ready,
        environmentId: placement.environmentId,
        state: "destroyed" as const,
        providerId,
        nodeDeviceId,
        profileId,
        profileSnapshot,
      };
      const source =
        state === "failed"
          ? { ...placement, executionMode, state, recoveryError: "Gateway restarted" }
          : { ...placement, executionMode };
      const requirement = {
        requiredNodeCommands: executionMode === "remote-exec" ? ["codex.exec-server.stdio.v1"] : [],
        consumesWorkerSlot: executionMode === "worker-turn",
      };
      const resolveDevicePlacementRequirement = vi.fn(async () => requirement);
      const dispatch = vi.fn(async () => ACTIVE_PLACEMENT);
      const redispatch = createWorkerPlacementRedispatch({
        placements: reader(source, environment),
        dispatch,
        resolveDevicePlacementRequirement,
      });

      await expect(redispatch(source, dispatchOptions)).resolves.toBe(ACTIVE_PLACEMENT);
      const identity = {
        sessionId: placement.sessionId,
        sessionKey: placement.sessionKey,
        agentId: placement.agentId,
        executionMode,
      };
      expect(dispatch).toHaveBeenCalledExactlyOnceWith(
        {
          ...identity,
          profileId,
          expectedPlacement: {
            state,
            generation: source.generation,
            environmentId: source.environmentId,
            activeOwnerEpoch: source.activeOwnerEpoch,
          },
          inheritedProfile: { providerId, profileSnapshot },
          ...(nodeDeviceId ? { devicePlacement: requirement } : {}),
          ...(providerId === "device" ? { deviceId: nodeDeviceId } : {}),
        },
        undefined,
        dispatchOptions.assertCurrent,
        undefined,
      );
      if (nodeDeviceId) {
        expect(resolveDevicePlacementRequirement).toHaveBeenCalledExactlyOnceWith(identity);
      } else {
        expect(resolveDevicePlacementRequirement).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { providerId: "device", executionMode: "worker-turn" },
    { providerId: "crabbox", executionMode: "remote-exec" },
  ] as const)(
    "rejects $providerId nodes without a runtime requirement owner",
    async ({ providerId, executionMode }) => {
      const dispatch = vi.fn();
      const source = { ...placement, executionMode };
      const redispatch = createWorkerPlacementRedispatch({
        placements: reader(source, {
          ...ready,
          environmentId: placement.environmentId,
          providerId,
          nodeDeviceId: "paired-node",
        }),
        dispatch,
      });
      await expect(redispatch({ ...placement, executionMode }, dispatchOptions)).rejects.toThrow(
        "authoritative runtime requirement",
      );
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it("rejects a missing prior environment", async () => {
    const dispatch = vi.fn();
    const redispatch = createWorkerPlacementRedispatch({
      placements: reader(placement, undefined),
      dispatch,
    });
    await expect(redispatch(placement, dispatchOptions)).rejects.toThrow(
      "has no environment record",
    );
    expect(dispatch).not.toHaveBeenCalled();
  });
});
