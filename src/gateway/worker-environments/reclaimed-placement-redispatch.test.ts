import { describe, expect, it, vi } from "vitest";
import { ACTIVE_PLACEMENT } from "./placement-dispatch-coordinator.test-support.js";
import { createDispatchEnvironmentFixtures } from "./placement-dispatch-test-fixtures.js";
import { createReclaimedPlacementRedispatch } from "./reclaimed-placement-redispatch.js";

const placement = { ...ACTIVE_PLACEMENT, state: "reclaimed" as const };
const dispatchOptions = { assertCurrent: () => {} };
const { ready } = createDispatchEnvironmentFixtures();
const profileSnapshot = {
  machineClass: "large",
  install: "bundle",
  settings: { region: "parent", device: "paired-node" },
} as const;

describe("createReclaimedPlacementRedispatch", () => {
  it.each([
    { providerId: "fake", nodeDeviceId: null, executionMode: "worker-turn" },
    { providerId: "device", nodeDeviceId: "paired-node", executionMode: "worker-turn" },
    { providerId: "crabbox", nodeDeviceId: "retired-node", executionMode: "remote-exec" },
  ] as const)(
    "preserves the $providerId profile and resolves its $executionMode destination",
    async ({ providerId, nodeDeviceId, executionMode }) => {
      const profileId = `profile-${providerId}`;
      const environment = { ...ready, providerId, nodeDeviceId, profileId, profileSnapshot };
      const requirement = {
        requiredNodeCommands: executionMode === "remote-exec" ? ["codex.exec-server.stdio.v1"] : [],
        consumesWorkerSlot: executionMode === "worker-turn",
      };
      const resolveDevicePlacementRequirement = vi.fn(async () => requirement);
      const dispatch = vi.fn(async () => ACTIVE_PLACEMENT);
      const redispatch = createReclaimedPlacementRedispatch({
        environments: { get: () => environment },
        dispatch,
        resolveDevicePlacementRequirement,
      });

      await expect(redispatch({ ...placement, executionMode }, dispatchOptions)).resolves.toBe(
        ACTIVE_PLACEMENT,
      );
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
      const redispatch = createReclaimedPlacementRedispatch({
        environments: { get: () => ({ ...ready, providerId, nodeDeviceId: "paired-node" }) },
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
    const redispatch = createReclaimedPlacementRedispatch({
      environments: { get: () => undefined },
      dispatch,
    });
    await expect(redispatch(placement, dispatchOptions)).rejects.toThrow(
      "has no environment record",
    );
    expect(dispatch).not.toHaveBeenCalled();
  });
});
