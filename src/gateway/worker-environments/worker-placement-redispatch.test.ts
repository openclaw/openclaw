import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as runtimeConfig from "../../config/runtime-snapshot.js";
import { ACTIVE_PLACEMENT } from "./placement-dispatch-coordinator.test-support.js";
import { createDispatchEnvironmentFixtures } from "./placement-dispatch-test-fixtures.js";
import type { WorkerEnvironmentPlacementFacts } from "./placement-read-projection.types.js";
import { createWorkerPlacementRedispatch } from "./worker-placement-redispatch.js";

const placement = { ...ACTIVE_PLACEMENT, state: "reclaimed" as const };
const dispatchOptions = { assertCurrent: () => {} };
const { ready } = createDispatchEnvironmentFixtures();
const environmentBase = { ...ready, environmentId: placement.environmentId };

const reader = (environment: WorkerEnvironmentPlacementFacts | undefined) => ({
  readProjection: async () => ({
    placements: new Map([[placement.sessionId, placement]]),
    environments: new Map(environment ? [[environment.environmentId, environment]] : []),
    moves: new Map(),
    pendingResults: new Map(),
    workspaceJournalOwnerSessionIds: new Set<string>(),
    workspaceResultReconcilingSessionIds: new Set<string>(),
    workspaceRecoveryPendingSessionIds: new Set<string>(),
  }),
});

beforeEach(() => runtimeConfig.setRuntimeConfigSnapshot({}));
afterEach(runtimeConfig.clearRuntimeConfigSnapshot);
it.each([null, "retired-node"])(
  "resolves only node-backed placement requirements (%s)",
  async (nodeDeviceId) => {
    const environment = {
      ...environmentBase,
      providerId: "crabbox",
      nodeDeviceId,
      profileSnapshot: { ...environmentBase.profileSnapshot, machineClass: "large", os: "linux" },
    };
    const requirement = { requiredNodeCommands: [], consumesWorkerSlot: true };
    const resolveRequirement = vi.fn(async () => requirement);
    const dispatch = vi.fn<Parameters<typeof createWorkerPlacementRedispatch>[0]["dispatch"]>(
      async () => ACTIVE_PLACEMENT,
    );
    const redispatch = createWorkerPlacementRedispatch({
      placements: reader(environment),
      dispatch,
      resolveDevicePlacementRequirement: resolveRequirement,
    });
    await expect(redispatch(placement, dispatchOptions)).resolves.toBe(ACTIVE_PLACEMENT);
    const request = dispatch.mock.calls[0]?.[0];
    expect(request).not.toHaveProperty("deviceId");
    expect(request).toMatchObject({ machineClass: "large", os: "linux" });
    if (nodeDeviceId) {
      expect(request?.devicePlacement).toEqual(requirement);
    } else {
      expect(request).not.toHaveProperty("devicePlacement");
      expect(resolveRequirement).not.toHaveBeenCalled();
    }
  },
);

it.each([
  [
    { ...environmentBase, providerId: "device", nodeDeviceId: "paired-node" },
    "authoritative runtime requirement",
  ],
  [undefined, "has no environment record"],
] as const)("rejects redispatch without %s: %s", async (environment, reason) => {
  const dispatch = vi.fn();
  const redispatch = createWorkerPlacementRedispatch({
    placements: reader(environment),
    dispatch,
  });
  await expect(redispatch(placement, dispatchOptions)).rejects.toThrow(reason);
  expect(dispatch).not.toHaveBeenCalled();
});

it("does not redispatch after authority is revoked during node requirement resolution", async () => {
  let current = true;
  const dispatch = vi.fn();
  const redispatch = createWorkerPlacementRedispatch({
    placements: reader({ ...environmentBase, nodeDeviceId: "paired-node" }),
    dispatch,
    resolveDevicePlacementRequirement: async () => {
      await Promise.resolve();
      current = false;
      return { requiredNodeCommands: [], consumesWorkerSlot: true };
    },
  });
  await expect(
    redispatch(placement, {
      assertCurrent: () => {
        if (!current) {
          throw new Error("recovery revoked");
        }
      },
    }),
  ).rejects.toThrow("recovery revoked");
  expect(dispatch).not.toHaveBeenCalled();
});
