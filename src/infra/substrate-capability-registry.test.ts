import { describe, expect, it } from "vitest";
import {
  findSubstratesByCapability,
  getSubstrateCapabilityEntry,
  listSubstrateCapabilityEntries,
  listSubstrateRegistrySymbols,
} from "./substrate-capability-registry.js";

describe("substrate capability registry", () => {
  it("declares the initial substrate entries", () => {
    expect(listSubstrateCapabilityEntries().map((entry) => entry.name)).toEqual([
      "session-delivery-queue",
      "TaskFlow",
      "continuation-delegate-store",
    ]);
  });

  it("keeps each entry queryable with the required descriptor fields", () => {
    const queue = getSubstrateCapabilityEntry("session-delivery-queue");

    expect(queue).toMatchObject({
      name: "session-delivery-queue",
      "transport-class": "filesystem-queue",
      "runtime-symbol": "enqueueSessionDelivery",
      "descriptor-symbol": "QueuedSessionDeliveryPayloadMetadata",
    });
    expect(queue?.capabilities).toContain("cross-session-addressable-enrichment");
    expect(queue?.capabilities).toContain("chain-budget-at-spawn");
  });

  it("answers capability lookups without scanning runtime files", () => {
    expect(findSubstratesByCapability("restart-survival").map((entry) => entry.name)).toEqual([
      "session-delivery-queue",
      "TaskFlow",
      "continuation-delegate-store",
    ]);
    expect(findSubstratesByCapability("sha256-idempotency").map((entry) => entry.name)).toEqual([
      "session-delivery-queue",
    ]);
  });

  it("exports runtime and descriptor symbols for lint-side adoption detection", () => {
    expect(listSubstrateRegistrySymbols()).toEqual(
      expect.arrayContaining([
        "enqueueSessionDelivery",
        "enqueuePostCompactionDelegateDelivery",
        "deliverQueuedPostCompactionDelegate",
        "QueuedSessionDeliveryPayloadMetadata",
        "createManagedTaskFlow",
        "TaskFlowRecord",
        "taskFlowEnqueuePendingDelegate",
        "PendingContinuationDelegate",
      ]),
    );
  });
});
