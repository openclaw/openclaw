import * as nodeCrypto from "@openclaw/normalization-core/node-crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyLoggingConfig, resetLogger } from "../logging/logger.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import * as runtimeStoreWriter from "./runtime-store-writer.js";
import { createTrajectoryRuntimeRecorder, toTrajectoryToolDefinitions } from "./runtime.js";

function arrayReturning(value: unknown): unknown[] {
  return Object.defineProperty([], "slice", {
    value: () => ({ map: () => value }),
  });
}

function projectParameters(parameters: unknown) {
  return toTrajectoryToolDefinitions([{ name: "sample", parameters }])[0]?.parameters;
}

describe("trajectory tool definition preparation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetSecretRedactionRegistryForTest();
    resetLogger();
  });

  it("reuses schema projection work across rebuilt tools without sharing mutable results", () => {
    const digest = vi.spyOn(nodeCrypto, "sha256Hex");
    const parameters = { imageData: "synthetic-trajectory-media", nested: { ordinary: "first" } };
    const project = () => toTrajectoryToolDefinitions([{ name: "sample", parameters }]);
    const first = project();
    const expected = structuredClone(first);
    Object.assign(first[0]!.parameters ?? {}, { nested: { ordinary: "overwritten" } });
    expect(project()).toEqual(expected);
    expect(digest).toHaveBeenCalledTimes(1);

    parameters.nested.ordinary = "changed";
    expect(project()[0]?.parameters).toMatchObject({ nested: { ordinary: "changed" } });
    expect(digest).toHaveBeenCalledTimes(2);
    registerSecretValueForRedaction("synthetic-new-registration");
    expect(project()[0]?.parameters).toMatchObject({ nested: { ordinary: "changed" } });
    expect(digest).toHaveBeenCalledTimes(3);
  });

  it("rechecks changed schemas and current secret registrations after repeated projections", () => {
    const writes: string[] = [];
    const description = "trajectory-fixture-value";
    vi.spyOn(runtimeStoreWriter, "createSqliteTrajectoryRuntimeSink").mockReturnValueOnce({
      write: (_event, line) => writes.push(line),
      flush: async () => {},
      describeFlushState: () => undefined,
    });
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "tool-projection",
    });
    const record = (text: string) =>
      recorder?.recordEvent("context.compiled", {
        tools: toTrajectoryToolDefinitions([{ name: "sample", parameters: { description: text } }]),
      });
    record(description);
    record(description);
    registerSecretValueForRedaction(description);
    record(description);
    record("Authorization: Bearer synthetic-changed-value");
    record("policy-fixture-value");
    applyLoggingConfig({ redactPatterns: ["policy-fixture-value"] });
    record("policy-fixture-value");
    applyLoggingConfig(undefined);
    record("policy-fixture-value");

    expect(writes).toHaveLength(7);
    expect(writes[0]).toContain(description);
    expect(writes[1]).toContain(description);
    expect(writes[2]).not.toContain(description);
    expect(writes[3]).not.toContain("synthetic-changed-value");
    expect(JSON.parse(writes[3]!).data.tools[0].parameters.description).toContain("redacted");
    expect(writes[4]).toContain("policy-fixture-value");
    expect(writes[5]).not.toContain("policy-fixture-value");
    expect(writes[6]).toContain("policy-fixture-value");
  });

  it("does not invoke custom serialization hooks or cache opaque array-operation results", () => {
    const toJSON = vi.fn(() => ({ unexpected: true }));
    const opaque = Object.defineProperty({ ordinary: "first" }, "toJSON", { value: toJSON });
    const parameters = arrayReturning(opaque);
    expect(projectParameters(parameters)).toEqual({ ordinary: "first" });
    opaque.ordinary = "second";
    expect(projectParameters(parameters)).toEqual({ ordinary: "second" });
    expect(toJSON).not.toHaveBeenCalled();
  });

  it("preserves truncation metadata without probing its records as native headers", () => {
    const has = vi.spyOn(Headers.prototype, "has");
    expect(projectParameters({ description: "x".repeat(32_769) })).toEqual({
      description: {
        truncated: true,
        reason: "trajectory-field-size-limit",
        originalChars: 32_769,
        limitChars: 32_768,
      },
    });
    expect(has).not.toHaveBeenCalled();
  });

  it("preserves native retry metadata returned by custom array operations", () => {
    const headers = new Headers({
      "retry-after": "7",
      authorization: "Bearer synthetic-credential",
    });

    expect(projectParameters({ ordinary: "kept", nested: arrayReturning(headers) })).toEqual({
      ordinary: "kept",
      nested: { "retry-after-ms": 7_000 },
    });
  });

  it("preserves prototype traps when a copied field changes the prepared record prototype", () => {
    const getPrototypeOf = vi.fn(() => null);
    const prototype = new Proxy({}, { getPrototypeOf });
    const parameters = {
      ["__proto__"]: arrayReturning(prototype),
      ordinary: "kept",
    };

    expect(projectParameters(parameters)).toEqual({ ordinary: "kept" });
    expect(getPrototypeOf).toHaveBeenCalled();
    expect(Object.getPrototypeOf(parameters)).toBe(Object.prototype);
  });

  it("reads source getters once while preserving inert serialization hooks", () => {
    const toJSON = vi.fn(() => ({ unexpected: true }));
    const readNested = vi.fn(() => ({ ordinary: "kept", password: "synthetic-secret", toJSON }));
    const parameters = Object.defineProperty({}, "nested", {
      enumerable: true,
      get: readNested,
    });

    expect(projectParameters(parameters)).toEqual({ nested: { ordinary: "kept", toJSON } });
    expect(readNested).toHaveBeenCalledOnce();
    expect(toJSON).not.toHaveBeenCalled();
  });
});
