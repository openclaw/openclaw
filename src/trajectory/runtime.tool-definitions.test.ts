import { publishRuntimeToolInputSchema } from "@openclaw/ai/internal/tool-schema";
import { afterEach, expect, it, vi } from "vitest";
import { applyLoggingConfig, resetLogger } from "../logging/logger.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import * as runtimeStoreWriter from "./runtime-store-writer.js";
import { createTrajectoryRuntimeRecorder, toTrajectoryToolDefinitions } from "./runtime.js";

function projectParameters(parameters: unknown) {
  return toTrajectoryToolDefinitions([{ name: "sample", parameters }])[0]?.parameters;
}

function toJSON(): never {
  throw new Error("Unexpected serialization or array hook");
}

afterEach(() => {
  vi.restoreAllMocks();
  resetSecretRedactionRegistryForTest();
  resetLogger();
});

it("reuses immutable projections across attempts and replacement publications", () => {
  const source = { type: "object", properties: { value: { type: "string" } } };
  const published = publishRuntimeToolInputSchema(source).schema;
  const first = projectParameters(published);
  expect(first).toEqual(source);
  expect(() => Object.assign(first ?? {}, { properties: {} })).toThrow(TypeError);
  const frozen = freezeJsonSnapshot({ imageData: "synthetic-frozen-media" });
  const other = projectParameters(frozen);
  expect(projectParameters(published)).toBe(first);
  expect(projectParameters(frozen)).toBe(other);
  source.properties.value.type = "number";
  expect(projectParameters(published)).toMatchObject({ properties: { value: { type: "string" } } });
  expect(projectParameters(publishRuntimeToolInputSchema(source).schema)).toEqual(source);
});

it("still bounds published JSON before caching its diagnostic projection", () => {
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
});

it("keeps schema text unchanged across secret registrations and log policy changes", async () => {
  const writes: string[] = [];
  const description = "Authorization: Bearer synthetic-trajectory-value";
  vi.spyOn(runtimeStoreWriter, "createSqliteTrajectoryRuntimeSink").mockResolvedValueOnce({
    write: (_event, line) => writes.push(line),
    flush: async () => {},
    describeFlushState: () => undefined,
  });
  const recorder = await createTrajectoryRuntimeRecorder({ sessionId: "tool-projection" });
  const record = () =>
    recorder?.recordEvent("context.compiled", {
      tools: toTrajectoryToolDefinitions([{ name: "sample", parameters: { description } }]),
    });
  record();
  registerSecretValueForRedaction(description);
  record();
  applyLoggingConfig({ redactPatterns: [description] });
  record();
  applyLoggingConfig(undefined);
  record();
  const captured = writes.map((line) => JSON.parse(line).data.tools[0].parameters.description);
  expect(captured).toEqual(Array(4).fill(description));
});

it("projects array elements without invoking custom array operations or serialization hooks", () => {
  const element = Object.defineProperty({ ordinary: "first" }, "toJSON", { value: toJSON });
  const parameters = Object.defineProperty([element], "slice", { value: toJSON });
  const projected = projectParameters(parameters);
  expect(projected).toEqual([{ ordinary: "first" }]);
  Object.assign(projected ?? {}, { 0: { ordinary: "overwritten" } });
  expect(projectParameters(parameters)).toEqual([{ ordinary: "first" }]);
  element.ordinary = "second";
  expect(projectParameters(parameters)).toEqual([{ ordinary: "second" }]);
});

it("reads source getters once while preserving inert serialization hooks", () => {
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
});

it("preserves non-JSON leaves instead of aliasing them with JSON cache entries", () => {
  for (const value of [undefined, Number.NaN, Infinity, -Infinity, -0, 1n, Symbol("fixture")]) {
    const inputs = () => [{ value: null }, {}, { value: 0 }, { value }];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(inputs().map(projectParameters)).toStrictEqual(inputs());
    }
  }
});

it("preserves opaque array truncation metadata without invoking serialization hooks", () => {
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
});
