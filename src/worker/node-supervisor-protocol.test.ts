import { expect, it } from "vitest";
import { testWorkerDescriptor } from "../node-host/node-worker-supervisor.test-support.js";
import {
  NODE_WORKER_CONNECTION_FAILURE_MESSAGE_TYPE,
  nodeWorkerPlanHash,
  parseNodeWorkerConnectionFailureMessage,
  parseNodeWorkerEnvironmentStopInput,
  parseNodeWorkerLaunchInput,
  parseNodeWorkerLookupInput,
  NODE_WORKER_STATUS_WAIT_MAX_MS,
  parseNodeWorkerSupervisorReceipt,
  type NodeWorkerSupervisorIdentity,
} from "./node-supervisor-protocol.js";

const identity: NodeWorkerSupervisorIdentity = {
  launchId: "launch-1",
  planHash: "a".repeat(64),
  environmentId: "environment-1",
  sessionId: "session-1",
  ownerEpoch: 3,
  placementGeneration: 4,
  runId: "run-1",
};

function launchInput() {
  const descriptor = testWorkerDescriptor("/tmp/worker", "success", "turn-1");
  return {
    environmentSession: 1,
    launchId: "turn-1",
    gatewayNamespace: "gateway-1",
    expectedBundleHash: descriptor.admission.handshake.bundleHash,
    placementGeneration: 4,
    descriptor,
  };
}

it("accepts only bounded optional status waits", () => {
  for (const waitMs of [undefined, 1, NODE_WORKER_STATUS_WAIT_MAX_MS]) {
    const input = { launchId: identity.launchId, ...(waitMs === undefined ? {} : { waitMs }) };
    expect(parseNodeWorkerLookupInput(JSON.stringify(input))).toEqual(input);
  }
  for (const waitMs of [0, -1, 1.5, "100", null, NODE_WORKER_STATUS_WAIT_MAX_MS + 1]) {
    expect(() =>
      parseNodeWorkerLookupInput(JSON.stringify({ launchId: identity.launchId, waitMs })),
    ).toThrow("INVALID_REQUEST");
  }
});

it("preserves published authoring and negotiated idle retention in launch identity", () => {
  for (const multipleProfiles of [undefined, false, true]) {
    const base = launchInput();
    const input = {
      ...base,
      descriptor: {
        ...base.descriptor,
        assignment: {
          ...base.descriptor.assignment,
          ...(multipleProfiles === undefined ? {} : { skillAuthoring: { multipleProfiles } }),
        },
      },
    };
    const legacy = parseNodeWorkerLaunchInput(JSON.stringify(input));
    expect(legacy).toEqual(input);
    if (multipleProfiles !== undefined) {
      expect(nodeWorkerPlanHash(legacy)).not.toBe(nodeWorkerPlanHash(base));
    }
    const retained = parseNodeWorkerLaunchInput(JSON.stringify({ ...input, idleRetention: true }));
    expect(retained).toEqual({ ...input, idleRetention: true });
    expect(nodeWorkerPlanHash(retained)).not.toBe(nodeWorkerPlanHash(legacy));
    expect(() =>
      parseNodeWorkerLaunchInput(JSON.stringify({ ...input, idleRetention: false })),
    ).toThrow("INVALID_REQUEST");
  }
});

it("rejects malformed authoring, unnegotiated lifetimes, and mismatched turn identities", () => {
  const input = launchInput();
  for (const skillAuthoring of [
    null,
    {},
    { multipleProfiles: "false" },
    { multipleProfiles: false, extra: true },
  ]) {
    expect(() =>
      parseNodeWorkerLaunchInput(
        JSON.stringify({
          ...input,
          descriptor: {
            ...input.descriptor,
            assignment: { ...input.descriptor.assignment, skillAuthoring },
          },
        }),
      ),
    ).toThrow("INVALID_REQUEST");
  }
  for (const environmentSession of [undefined, 2]) {
    expect(() =>
      parseNodeWorkerLaunchInput(JSON.stringify({ ...input, environmentSession })),
    ).toThrow("INVALID_REQUEST");
  }
  expect(() =>
    parseNodeWorkerLaunchInput(JSON.stringify({ ...input, launchId: "other-launch" })),
  ).toThrow("launchId must match descriptor assignment turnId");
});

it("requires a complete bounded environment owner independently of its completed turn", () => {
  const scope = {
    gatewayNamespace: "gateway-1",
    environmentId: "environment-1",
    sessionId: "session-1",
    ownerEpoch: 3,
  };
  expect(parseNodeWorkerEnvironmentStopInput(JSON.stringify(scope))).toEqual(scope);
  for (const fields of [
    { ownerEpoch: undefined },
    { ownerEpoch: -1 },
    { sessionId: "" },
    { gatewayNamespace: "../gateway" },
    { launchId: "turn-1" },
    { environmentId: "x".repeat(4096) },
  ]) {
    expect(() =>
      parseNodeWorkerEnvironmentStopInput(JSON.stringify({ ...scope, ...fields })),
    ).toThrow("INVALID_REQUEST");
  }
});

it("accepts only bounded worker connection diagnostics", () => {
  for (const cause of ["certificate rejected", null]) {
    const message = { type: NODE_WORKER_CONNECTION_FAILURE_MESSAGE_TYPE, cause };
    expect(parseNodeWorkerConnectionFailureMessage(message)).toEqual(message);
  }
  expect(
    parseNodeWorkerConnectionFailureMessage({
      type: NODE_WORKER_CONNECTION_FAILURE_MESSAGE_TYPE,
      cause: "x".repeat(64 * 1024 + 1),
    }),
  ).toBeNull();
});

it("round-trips only closed receipts with bounded output or single-line failure diagnostics", () => {
  for (const fields of [
    { state: "pending" },
    { state: "running" },
    {
      state: "completed",
      resultJson: JSON.stringify({ status: "completed", transcriptNextSeq: 2 }),
    },
    { state: "failed", errorText: "worker exited before completion" },
    { state: "interrupted", errorText: "node host stopped" },
    { state: "cancelled", errorText: "node worker launch cancelled" },
  ]) {
    const receipt = { ...identity, ...fields };
    expect(parseNodeWorkerSupervisorReceipt(receipt)).toEqual(receipt);
  }
  for (const receipt of [
    "{",
    null,
    ...[
      { state: "running", workerPid: 123 },
      { state: "running", planHash: undefined },
      { state: "completed" },
      { state: "completed", resultJson: "{" },
      { state: "completed", resultJson: JSON.stringify({ text: "x".repeat(64 * 1024) }) },
      { state: "failed" },
      { state: "failed", errorText: "first\nsecond" },
      { state: "failed", errorText: "x".repeat(4 * 1024 + 1) },
    ].map((fields) => Object.assign({}, identity, fields)),
  ]) {
    expect(parseNodeWorkerSupervisorReceipt(receipt)).toBeNull();
  }
});
