import { expect, it } from "vitest";
import {
  testWorkerLaunchInput,
  testNodeWorkerLaunchIdentity,
} from "../node-host/node-worker-supervisor.test-support.js";
import * as protocol from "./node-supervisor-protocol.js";

const launchInput = () => testWorkerLaunchInput("/tmp/worker", "turn-1");
const identity = testNodeWorkerLaunchIdentity(launchInput());
const parseLaunch = (input: unknown) => protocol.parseNodeWorkerLaunchInput(JSON.stringify(input));
const parseLookup = (input: unknown) => protocol.parseNodeWorkerLookupInput(JSON.stringify(input));
const parseStop = (input: unknown) =>
  protocol.parseNodeWorkerEnvironmentStopInput(JSON.stringify(input));
const failureType = protocol.NODE_WORKER_CONNECTION_FAILURE_MESSAGE_TYPE;
const maxWait = protocol.NODE_WORKER_STATUS_WAIT_MAX_MS;
const parseFailure = (cause: string | null) =>
  protocol.parseNodeWorkerConnectionFailureMessage({ type: failureType, cause });
function withAuthoring(base: ReturnType<typeof launchInput>, skillAuthoring: unknown) {
  return {
    ...base,
    descriptor: {
      ...base.descriptor,
      assignment: { ...base.descriptor.assignment, skillAuthoring },
    },
  };
}

it.each([
  [undefined, "paramsJSON required"],
  [null, "paramsJSON required"],
  ["", "paramsJSON required"],
  ["{", "paramsJSON malformed JSON"],
] as const)("rejects invalid lookup framing %j", (raw, message) => {
  expect(() => protocol.parseNodeWorkerLookupInput(raw)).toThrow(`INVALID_REQUEST: ${message}`);
});

it("accepts only bounded optional status waits", () => {
  for (const waitMs of [undefined, 1, maxWait]) {
    const input = { launchId: identity.launchId, ...(waitMs === undefined ? {} : { waitMs }) };
    expect(parseLookup(input)).toEqual(input);
  }
  for (const waitMs of [0, -1, 1.5, "100", null, maxWait + 1]) {
    expect(() => parseLookup({ launchId: identity.launchId, waitMs })).toThrow("INVALID_REQUEST");
  }
});

it("preserves published authoring and negotiated idle retention in launch identity", () => {
  for (const multipleProfiles of [undefined, false, true]) {
    const base = launchInput();
    const input = multipleProfiles === undefined ? base : withAuthoring(base, { multipleProfiles });
    const legacy = parseLaunch(input);
    expect(legacy).toEqual(input);
    if (multipleProfiles !== undefined) {
      expect(protocol.nodeWorkerPlanHash(legacy)).not.toBe(protocol.nodeWorkerPlanHash(base));
    }
    const retained = parseLaunch({ ...input, idleRetention: true });
    expect(retained).toEqual({ ...input, idleRetention: true });
    expect(protocol.nodeWorkerPlanHash(retained)).not.toBe(protocol.nodeWorkerPlanHash(legacy));
    expect(() => parseLaunch({ ...input, idleRetention: false })).toThrow("INVALID_REQUEST");
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
    expect(() => parseLaunch(withAuthoring(input, skillAuthoring))).toThrow("INVALID_REQUEST");
  }
  for (const environmentSession of [undefined, 2]) {
    expect(() => parseLaunch({ ...input, environmentSession })).toThrow("INVALID_REQUEST");
  }
  expect(() => parseLaunch({ ...input, launchId: "other-launch" })).toThrow(
    "launchId must match descriptor assignment turnId",
  );
});

it("requires a complete bounded environment owner independently of its completed turn", () => {
  const { environmentId, sessionId, ownerEpoch } = identity;
  const scope = { gatewayNamespace: "gateway-1", environmentId, sessionId, ownerEpoch };
  expect(parseStop(scope)).toEqual(scope);
  for (const fields of [
    { ownerEpoch: undefined },
    { ownerEpoch: -1 },
    { sessionId: "" },
    { gatewayNamespace: "../gateway" },
    { launchId: "turn-1" },
    { environmentId: "x".repeat(4096) },
  ]) {
    expect(() => parseStop({ ...scope, ...fields })).toThrow("INVALID_REQUEST");
  }
});

it("accepts only bounded worker connection diagnostics", () => {
  for (const cause of ["certificate rejected", null]) {
    expect(parseFailure(cause)).toEqual({ type: failureType, cause });
  }
  expect(parseFailure("x".repeat(64 * 1024 + 1))).toBeNull();
});

it("round-trips only closed receipts with bounded output or single-line failure diagnostics", () => {
  for (const fields of [
    { state: "pending" },
    { state: "running" },
    { state: "completed", resultJson: "{}" },
    { state: "failed", errorText: "worker exited before completion" },
    { state: "interrupted", errorText: "node host stopped" },
    { state: "cancelled", errorText: "node worker launch cancelled" },
  ]) {
    const receipt = { ...identity, ...fields };
    expect(protocol.parseNodeWorkerSupervisorReceipt(receipt)).toEqual(receipt);
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
    expect(protocol.parseNodeWorkerSupervisorReceipt(receipt)).toBeNull();
  }
});
