import { publishRuntimeToolInputSchema } from "@openclaw/ai/internal/tool-schema";
import * as nodeCrypto from "@openclaw/normalization-core/node-crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyLoggingConfig, resetLogger } from "../logging/logger.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
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
    expect(project()).toEqual(expected);
    expect(digest).toHaveBeenCalledTimes(1);

    parameters.nested.ordinary = "changed";
    expect(project()[0]?.parameters).toMatchObject({ nested: { ordinary: "changed" } });
    expect(digest).toHaveBeenCalledTimes(2);
    registerSecretValueForRedaction("synthetic-new-registration");
    expect(project()[0]?.parameters).toMatchObject({ nested: { ordinary: "changed" } });
    expect(digest).toHaveBeenCalledTimes(2);
  });

  it("reuses published schemas while isolating results and replacement publications", () => {
    const source = { type: "object", properties: { value: { type: "string" } } };
    const published = publishRuntimeToolInputSchema(source).schema;
    const first = projectParameters(published);
    expect(first).toEqual(source);
    Object.assign(first ?? {}, { properties: {} });
    expect(projectParameters(published)).toEqual(source);

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

    expect(projectParameters(parameters)).toEqual({
      nested: { ordinary: "kept", password: "synthetic-secret", toJSON },
    });
    expect(readNested).toHaveBeenCalledOnce();
    expect(toJSON).not.toHaveBeenCalled();
  });
});
