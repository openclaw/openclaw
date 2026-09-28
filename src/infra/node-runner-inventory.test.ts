import { describe, expect, it } from "vitest";
import { availableWorkerSlots } from "../shared/node-list-parse.js";
import {
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
  parseNodeRunnerInventoryDeclaration,
  type NodeWorkerCapacitySnapshot,
} from "./node-runner-inventory.js";

const capacity = { total: 2, available: 1 };
const workerHost = {
  enabled: true,
  capacity,
  bundlePrewarm: 1,
  bundleRetention: 1,
  bundleStatus: 1,
  portalStream: 1,
  environmentSession: 1,
  statusWait: 1,
  preparedWorkspace: 1,
  capturedExecPolicy: true,
};
const declaration = (host: unknown) => ({
  protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
  workerHost: host,
});

it("copies current hosting declarations and omits absent optional capabilities", () => {
  for (const host of [workerHost, { enabled: false }, { enabled: true, capacity }]) {
    const input = declaration(host);
    const parsed = parseNodeRunnerInventoryDeclaration(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    if (parsed && "workerHost" in parsed && parsed.workerHost.enabled) {
      expect(parsed.workerHost.capacity).not.toBe(capacity);
    }
  }
  expect(
    parseNodeRunnerInventoryDeclaration(
      declaration({ enabled: true, capacity, statusWait: undefined }),
    ),
  ).toStrictEqual(declaration({ enabled: true, capacity }));
});

it.each([
  { ...workerHost, statusWait: 2 },
  { ...workerHost, capturedExecPolicy: false },
  { ...workerHost, bundleRetention: undefined },
  { ...workerHost, unexpected: true },
  { enabled: false, statusWait: 1 },
  { ...workerHost, capacity: { total: 0, available: 0 } },
  { ...workerHost, capacity: { total: 1_025, available: 0 } },
  { ...workerHost, capacity: { total: 2, available: 3 } },
  { ...workerHost, capacity: { total: 2, available: -1 } },
  { ...workerHost, capacity: { total: 2, available: 0.5 } },
  { ...workerHost, capacity: { ...capacity, unexpected: true } },
])("rejects invalid hosting capabilities or capacity: %j", (host) => {
  expect(parseNodeRunnerInventoryDeclaration(declaration(host))).toBeNull();
});

it("keeps retired dialect markers observational and empty declarations valid", () => {
  expect(parseNodeRunnerInventoryDeclaration({ protocolFeatures: [] })).toEqual({
    protocolFeatures: [],
  });
  const protocolFeatures = ["node-worker-supervisor-v5"];
  expect(parseNodeRunnerInventoryDeclaration({ protocolFeatures, workerHost })).toEqual({
    protocolFeatures,
  });
});

describe("idle worker capacity negotiation", () => {
  const declaration = (capacity: unknown, idleRetention?: unknown) => ({
    protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
    workerHost: {
      enabled: true,
      capacity,
      statusWait: 1,
      ...(idleRetention === undefined ? {} : { idleRetention }),
    },
  });

  it.each<[NodeWorkerCapacitySnapshot, true | undefined]>([
    [{ total: 1, available: 1 }, undefined],
    [{ total: 1, available: 0, reclaimableIdle: 1 }, true],
    [{ total: 4, available: 1, reclaimableIdle: 2 }, true],
  ])("preserves exact negotiated inventory shape %j", (capacity, idleRetention) => {
    const input = declaration(capacity, idleRetention);
    expect(parseNodeRunnerInventoryDeclaration(input)).toEqual(input);
    expect(availableWorkerSlots(capacity)).toBe(
      capacity.available + (capacity.reclaimableIdle ?? 0),
    );
  });

  it.each([
    [{ total: 1, available: 0, reclaimableIdle: 1 }, undefined],
    [{ total: 1, available: 1, reclaimableIdle: 1 }, true],
    [{ total: 4, available: 0, reclaimableIdle: 3 }, true],
    [{ total: 1, available: 0, reclaimableIdle: -1 }, true],
    [{ total: 1, available: 0, reclaimableIdle: 0.5 }, true],
    [{ total: 1, available: 0, reclaimableIdle: 0 }, false],
    [{ total: 1, available: 0, busy: 1 }, true],
  ])("rejects unnegotiated or invalid reclaimable capacity %j", (capacity, idleRetention) => {
    expect(parseNodeRunnerInventoryDeclaration(declaration(capacity, idleRetention))).toBeNull();
  });

  it.each([
    { enabled: false, capacity: { total: 1, available: 1 } },
    { enabled: true },
    { enabled: true, capacity: { total: 1, available: 1 }, bundleStatus: 1 },
    { enabled: true, capacity: { total: 1, available: 1 }, preparedWorkspace: 2 },
    Object.create({ enabled: true, capacity: { total: 1, available: 1 } }),
  ])("preserves closed host declarations and capability dependencies %j", (workerHost) => {
    expect(
      parseNodeRunnerInventoryDeclaration({
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost,
      }),
    ).toBeNull();
  });
});
