import { describe, expect, it } from "vitest";
import {
  parseNodeWorkerWorkspaceRetainInput,
  parseNodeWorkerWorkspaceRetainResult,
} from "./node-workspace-retain-protocol.js";

const entry = {
  environmentId: "environment-1",
  sessionId: "session-1",
  generation: 3,
  manifestRefs: [`sha256:${"a".repeat(64)}`],
};
const request = {
  version: 1,
  gatewayNamespace: "gateway-test",
  controllerId: "controller-1",
  sequence: 1,
  retain: [],
};

describe("node workspace retain protocol", () => {
  it("parses and canonicalizes a bounded full snapshot", () => {
    const second = { ...entry, environmentId: "environment-2", manifestRefs: null };
    const snapshot = {
      ...request,
      sequence: 4,
      bundleHashes: ["b".repeat(64), "a".repeat(64)],
      acknowledgedBundleGeneration: 3,
      bundleStatusHash: "a".repeat(64),
      retain: [second, entry],
    };
    expect(parseNodeWorkerWorkspaceRetainInput(JSON.stringify(snapshot))).toEqual({
      ...snapshot,
      bundleHashes: ["a".repeat(64), "b".repeat(64)],
      retain: [entry, second],
    });
  });

  it.each([
    { ...entry, extra: true },
    { ...entry, generation: 0 },
    { ...entry, manifestRefs: ["not-a-ref"] },
  ])("rejects an invalid retain entry %#", (invalid) => {
    expect(() =>
      parseNodeWorkerWorkspaceRetainInput(JSON.stringify({ ...request, retain: [invalid] })),
    ).toThrow("INVALID_REQUEST");
  });

  it("rejects a bundle status hash that is not retained", () => {
    expect(() =>
      parseNodeWorkerWorkspaceRetainInput(
        JSON.stringify({
          ...request,
          bundleHashes: ["a".repeat(64)],
          bundleStatusHash: "b".repeat(64),
        }),
      ),
    ).toThrow("must be retained");
  });

  it("rejects a bundle-generation acknowledgement without bundle hashes", () => {
    expect(() =>
      parseNodeWorkerWorkspaceRetainInput(
        JSON.stringify({ ...request, acknowledgedBundleGeneration: 3 }),
      ),
    ).toThrow("requires bundleHashes");
  });

  it("rejects duplicate generation ownership", () => {
    expect(() =>
      parseNodeWorkerWorkspaceRetainInput(JSON.stringify({ ...request, retain: [entry, entry] })),
    ).toThrow("must be unique");
  });

  it("parses only the exact bounded result", () => {
    const result = {
      applied: true,
      deleted: 2,
      hasMore: false,
      bundleDeleted: 3,
      bundleGeneration: 4,
      bundleStatus: { bundleHash: "a".repeat(64), status: "installed" },
    };
    expect(parseNodeWorkerWorkspaceRetainResult(structuredClone(result))).toEqual(result);
    expect(
      parseNodeWorkerWorkspaceRetainResult({
        applied: true,
        deleted: 2,
        hasMore: false,
        extra: true,
      }),
    ).toBeNull();
  });
});
