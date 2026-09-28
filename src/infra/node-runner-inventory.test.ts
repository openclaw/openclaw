import { expect, it } from "vitest";
import { parseNodeRunnerInventoryDeclaration } from "./node-runner-inventory.js";

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
  protocolFeatures: ["node-worker-supervisor-v6"],
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
