import { describe, expect, it } from "vitest";
import { availableWorkerSlots } from "../../packages/gateway-protocol/src/worker-capacity.js";
import {
  createNodeRunnerInventoryIssueError,
  NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
  parseNodeRunnerInventoryDeclaration,
  resolveNodeWorkerExecutionIssue,
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
  promptContext: 1,
};
const declaration = (host: unknown) => ({
  protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
  workerHost: host,
});

it.each([{ ...workerHost, capacity: { total: 2, available: 3 } }])(
  "rejects invalid hosting capabilities or capacity: %j",
  (host) => {
    expect(parseNodeRunnerInventoryDeclaration(declaration(host))).toBeNull();
  },
);

it("keeps retired dialect markers observational and empty declarations valid", () => {
  expect(parseNodeRunnerInventoryDeclaration({ protocolFeatures: [] })).toEqual({
    protocolFeatures: [],
  });
  const protocolFeatures = ["node-worker-supervisor-v5"];
  expect(parseNodeRunnerInventoryDeclaration({ protocolFeatures, workerHost })).toEqual({
    protocolFeatures,
  });
});

it("retains the private node diagnostic under a typed update code", () => {
  const error = createNodeRunnerInventoryIssueError(
    "private-node-id",
    NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
  );
  expect(error).toMatchObject({
    name: "NodeRunnerUpdateRequiredError",
    code: "node_runner_update_required",
  });
  expect(error.message).toContain("private-node-id");
});

it("keeps old inventories observable but requires prompt context for execution", () => {
  for (const promptContext of [undefined, 1]) {
    const parsed = parseNodeRunnerInventoryDeclaration(
      declaration({ ...workerHost, promptContext }),
    );
    expect(parsed).not.toBeNull();
    if (!parsed || !("workerHost" in parsed)) {
      throw new Error("expected worker host inventory");
    }
    expect(resolveNodeWorkerExecutionIssue(parsed.workerHost)).toBe(
      promptContext === 1 ? undefined : NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
    );
  }
  expect(resolveNodeWorkerExecutionIssue({ enabled: false })).toBeUndefined();
});

describe("idle worker capacity negotiation", () => {
  const idleDeclaration = (slots: unknown, idleRetention?: unknown) => ({
    protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
    workerHost: {
      enabled: true,
      capacity: slots,
      statusWait: 1,
      ...(idleRetention === undefined ? {} : { idleRetention }),
    },
  });

  it.each<[NodeWorkerCapacitySnapshot, true | undefined]>([
    [{ total: 4, available: 1, reclaimableIdle: 2 }, true],
  ])("preserves exact negotiated inventory shape %j", (slots, idleRetention) => {
    const input = idleDeclaration(slots, idleRetention);
    expect(parseNodeRunnerInventoryDeclaration(input)).toEqual(input);
    expect(availableWorkerSlots(slots)).toBe(slots.available + (slots.reclaimableIdle ?? 0));
  });
});
