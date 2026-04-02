import { afterEach, describe, expect, it } from "vitest";
import {
  findLatestFlowForOwner,
  getFlowByIdForOwner,
  listFlowsForOwner,
  resolveFlowForLookupTokenForOwner,
} from "./flow-owner-access.js";
import { createManagedFlow, resetFlowRegistryForTests } from "./flow-registry.js";

afterEach(() => {
  resetFlowRegistryForTests({ persist: false });
});

describe("flow owner access", () => {
  it("returns owner-scoped flows for direct and owner-key lookups", () => {
    const older = createManagedFlow({
      ownerKey: "agent:main:main",
      controllerId: "tests/owner-access",
      goal: "Older flow",
      createdAt: 100,
      updatedAt: 100,
    });
    const latest = createManagedFlow({
      ownerKey: "agent:main:main",
      controllerId: "tests/owner-access",
      goal: "Latest flow",
      createdAt: 200,
      updatedAt: 200,
    });

    expect(
      getFlowByIdForOwner({
        flowId: older.flowId,
        callerOwnerKey: "agent:main:main",
      })?.flowId,
    ).toBe(older.flowId);
    expect(
      findLatestFlowForOwner({
        callerOwnerKey: "agent:main:main",
      })?.flowId,
    ).toBe(latest.flowId);
    expect(
      resolveFlowForLookupTokenForOwner({
        token: "agent:main:main",
        callerOwnerKey: "agent:main:main",
      })?.flowId,
    ).toBe(latest.flowId);
    expect(
      listFlowsForOwner({
        callerOwnerKey: "agent:main:main",
      }).map((flow) => flow.flowId),
    ).toEqual([latest.flowId, older.flowId]);
  });

  it("denies cross-owner flow reads", () => {
    const flow = createManagedFlow({
      ownerKey: "agent:main:main",
      controllerId: "tests/owner-access",
      goal: "Hidden flow",
    });

    expect(
      getFlowByIdForOwner({
        flowId: flow.flowId,
        callerOwnerKey: "agent:main:other",
      }),
    ).toBeUndefined();
    expect(
      resolveFlowForLookupTokenForOwner({
        token: flow.flowId,
        callerOwnerKey: "agent:main:other",
      }),
    ).toBeUndefined();
    expect(
      resolveFlowForLookupTokenForOwner({
        token: "agent:main:main",
        callerOwnerKey: "agent:main:other",
      }),
    ).toBeUndefined();
    expect(
      listFlowsForOwner({
        callerOwnerKey: "agent:main:other",
      }),
    ).toEqual([]);
  });
});
