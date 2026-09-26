import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyLoggingConfig, resetLogger } from "../logging/logger.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { createTrajectoryRuntimeRecorder, toTrajectoryToolDefinitions } from "./runtime.js";

function arrayReturning(value: unknown): unknown[] {
  return Object.defineProperty([], "slice", {
    value: () => ({ map: () => value }),
  });
}

describe("trajectory tool definition preparation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetSecretRedactionRegistryForTest();
    resetLogger();
  });

  it("reuses schema projection work across rebuilt tools without sharing mutable results", () => {
    const digest = vi.spyOn(crypto, "createHash");
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
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "tool-projection",
      writer: {
        filePath: "/unused/trajectory.jsonl",
        write: (line) => writes.push(line),
        flush: async () => undefined,
      },
    });
    const record = (text: string) =>
      recorder?.recordEvent("context.compiled", {
        tools: toTrajectoryToolDefinitions([{ name: "sample", parameters: { description: text } }]),
      });
    try {
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
    } finally {
      resetSecretRedactionRegistryForTest();
    }
  });

  it("does not invoke custom serialization hooks or cache opaque array-operation results", () => {
    const toJSON = vi.fn(() => ({ unexpected: true }));
    const opaque = Object.defineProperty({ ordinary: "first" }, "toJSON", { value: toJSON });
    const parameters = arrayReturning(opaque);
    expect(toTrajectoryToolDefinitions([{ name: "sample", parameters }])[0]?.parameters).toEqual({
      ordinary: "first",
    });
    opaque.ordinary = "second";
    expect(toTrajectoryToolDefinitions([{ name: "sample", parameters }])[0]?.parameters).toEqual({
      ordinary: "second",
    });
    expect(toJSON).not.toHaveBeenCalled();
  });

  it("preserves truncation metadata without probing its records as native headers", () => {
    const has = vi.spyOn(Headers.prototype, "has");
    try {
      expect(
        toTrajectoryToolDefinitions([
          { name: "sample", parameters: { description: "x".repeat(32_769) } },
        ]),
      ).toEqual([
        {
          name: "sample",
          description: undefined,
          parameters: {
            description: {
              truncated: true,
              reason: "trajectory-field-size-limit",
              originalChars: 32_769,
              limitChars: 32_768,
            },
          },
        },
      ]);
      expect(has).not.toHaveBeenCalled();
    } finally {
      has.mockRestore();
    }
  });

  it("preserves native retry metadata returned by custom array operations", () => {
    const headers = new Headers({
      "retry-after": "7",
      authorization: "Bearer synthetic-credential",
    });

    expect(
      toTrajectoryToolDefinitions([
        {
          name: "sample",
          parameters: { ordinary: "kept", nested: arrayReturning(headers) },
        },
      ]),
    ).toEqual([
      {
        name: "sample",
        description: undefined,
        parameters: { ordinary: "kept", nested: { "retry-after-ms": 7_000 } },
      },
    ]);
  });

  it("preserves prototype traps when a copied field changes the prepared record prototype", () => {
    const getPrototypeOf = vi.fn(() => null);
    const prototype = new Proxy({}, { getPrototypeOf });
    const parameters = {
      ["__proto__"]: arrayReturning(prototype),
      ordinary: "kept",
    };

    expect(toTrajectoryToolDefinitions([{ name: "sample", parameters }])).toEqual([
      { name: "sample", description: undefined, parameters: { ordinary: "kept" } },
    ]);
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

    expect(toTrajectoryToolDefinitions([{ name: "sample", parameters }])).toEqual([
      {
        name: "sample",
        description: undefined,
        parameters: { nested: { ordinary: "kept", toJSON } },
      },
    ]);
    expect(readNested).toHaveBeenCalledOnce();
    expect(toJSON).not.toHaveBeenCalled();
  });
});
