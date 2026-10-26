import { publishRuntimeToolInputSchema } from "@openclaw/ai/internal/tool-schema";
import * as nodeCrypto from "@openclaw/normalization-core/node-crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyLoggingConfig, resetLogger } from "../logging/logger.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import * as runtimeStoreWriter from "./runtime-store-writer.js";
import { createTrajectoryRuntimeRecorder, toTrajectoryToolDefinitions } from "./runtime.js";

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
    const descriptors = vi.spyOn(Object, "getOwnPropertyDescriptor");
    const repeated = project();
    const descriptorReads = descriptors.mock.calls.length;
    descriptors.mockRestore();
    expect(repeated).toEqual(expected);
    expect(descriptorReads).toBe(0);
    expect(digest).toHaveBeenCalledTimes(1);

    parameters.nested.ordinary = "changed";
    expect(project()[0]?.parameters).toMatchObject({ nested: { ordinary: "changed" } });
    expect(digest).toHaveBeenCalledTimes(2);
    registerSecretValueForRedaction("synthetic-new-registration");
    expect(project()[0]?.parameters).toMatchObject({ nested: { ordinary: "changed" } });
    expect(digest).toHaveBeenCalledTimes(2);
  });

  it("reuses immutable projections across attempts and replacement publications", () => {
    const source = { type: "object", properties: { value: { type: "string" } } };
    const published = publishRuntimeToolInputSchema(source).schema;
    const first = projectParameters(published);
    expect(first).toEqual(source);
    expect(() => Object.assign(first ?? {}, { properties: {} })).toThrow(TypeError);
    const frozen = freezeJsonSnapshot({ imageData: "synthetic-frozen-media" });
    const digest = vi.spyOn(nodeCrypto, "sha256Hex");
    const other = projectParameters(frozen);
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(projectParameters(published)).toBe(first);
      expect(projectParameters(frozen)).toBe(other);
    }
    expect(digest).toHaveBeenCalledTimes(1);

    source.properties.value.type = "number";
    expect(projectParameters(published)).toMatchObject({
      properties: { value: { type: "string" } },
    });
    expect(projectParameters(publishRuntimeToolInputSchema(source).schema)).toEqual(source);
  });

  it("still bounds published JSON before caching its diagnostic projection", () => {
    const has = vi.spyOn(Headers.prototype, "has");
    const source = { description: "x".repeat(32_769) };
    const published = publishRuntimeToolInputSchema(source).schema;
    for (const parameters of [source, published, source, published]) {
      expect(projectParameters(parameters)).toEqual({
        description: {
          truncated: true,
          reason: "trajectory-field-size-limit",
          originalChars: 32_769,
          limitChars: 32_768,
        },
      });
    }
    expect(has).not.toHaveBeenCalled();
  });

  it("keeps schema text unchanged across secret registrations and log policy changes", async () => {
    const writes: string[] = [];
    const description = "trajectory-fixture-value";
    const policy = "policy-fixture-value";
    const bearer = "Authorization: Bearer synthetic-changed-value";
    vi.spyOn(runtimeStoreWriter, "createSqliteTrajectoryRuntimeSink").mockResolvedValueOnce({
      write: (_event, line) => writes.push(line),
      flush: async () => {},
      describeFlushState: () => undefined,
    });
    const recorder = await createTrajectoryRuntimeRecorder({ sessionId: "tool-projection" });
    const record = (text: string) =>
      recorder?.recordEvent("context.compiled", {
        tools: toTrajectoryToolDefinitions([{ name: "sample", parameters: { description: text } }]),
      });
    record(description);
    record(description);
    registerSecretValueForRedaction(description);
    record(description);
    record(bearer);
    record(policy);
    applyLoggingConfig({ redactPatterns: [policy] });
    record(policy);
    applyLoggingConfig(undefined);
    record(policy);

    const captured = writes.map((line) => JSON.parse(line).data.tools[0].parameters.description);
    const expected = [description, description, description, bearer, policy, policy, policy];
    expect(captured).toEqual(expected);
  });

  it("projects array elements without invoking custom array operations or serialization hooks", () => {
    const toJSON = vi.fn(() => ({ unexpected: true }));
    const slice = vi.fn(() => [{ unexpected: true }]);
    const element = Object.defineProperty({ ordinary: "first" }, "toJSON", { value: toJSON });
    const parameters = Object.defineProperty([element], "slice", { value: slice });
    expect(projectParameters(parameters)).toEqual([{ ordinary: "first" }]);
    element.ordinary = "second";
    expect(projectParameters(parameters)).toEqual([{ ordinary: "second" }]);
    expect(slice).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
  });

  it("reads source getters once while preserving inert serialization hooks", () => {
    const toJSON = vi.fn(() => ({ unexpected: true }));
    const readNested = vi.fn(() => ({ ordinary: "kept", password: "synthetic-secret", toJSON }));
    const parameters = Object.defineProperty({}, "nested", { enumerable: true, get: readNested });

    const readParameters = vi.fn(() => parameters);
    const tool = Object.defineProperty({ name: "sample" }, "parameters", { get: readParameters });
    expect(toTrajectoryToolDefinitions([tool])[0]?.parameters).toEqual({
      nested: { ordinary: "kept", password: "synthetic-secret", toJSON },
    });
    expect(readNested).toHaveBeenCalledOnce();
    expect(readParameters).toHaveBeenCalledOnce();
    const inheritedHook = Object.defineProperty({}, "__proto__", {
      enumerable: true,
      value: { toJSON },
    });
    expect(projectParameters(inheritedHook)).toEqual({});
    expect(toJSON).not.toHaveBeenCalled();
  });

  it("preserves non-JSON leaves instead of aliasing them with JSON cache entries", () => {
    for (const value of [undefined, Number.NaN, Infinity, -Infinity, -0, 1n, Symbol("fixture")]) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(projectParameters({ value: null })).toStrictEqual({ value: null });
        expect(projectParameters({})).toStrictEqual({});
        expect(projectParameters({ value: 0 })).toStrictEqual({ value: 0 });
        expect(projectParameters({ value })).toStrictEqual({ value });
      }
    }
  });

  it("preserves opaque array truncation metadata without invoking serialization hooks", () => {
    const toJSON = vi.fn(() => {
      throw new Error("Unexpected serialization hook");
    });
    const entries = Array.from({ length: 64 }, () => 42);
    for (const length of [Infinity, { valueOf: () => 65, toJSON }]) {
      const parameters = new Proxy(entries, {
        get(target, key, receiver) {
          return key === "length" ? length : Reflect.get(target, key, receiver);
        },
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(projectParameters(parameters)).toEqual([
          ...entries,
          {
            truncated: true,
            reason: "trajectory-array-size-limit",
            originalLength: length,
            limitItems: 64,
          },
        ]);
      }
    }
    expect(toJSON).not.toHaveBeenCalled();
  });
});
