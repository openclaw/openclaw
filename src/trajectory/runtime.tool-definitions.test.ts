import { describe, expect, it, vi } from "vitest";
import { toTrajectoryToolDefinitions } from "./runtime.js";

function arrayReturning(value: unknown): unknown[] {
  return Object.defineProperty([], "slice", {
    value: () => ({ map: () => value }),
  });
}

describe("trajectory tool definition preparation", () => {
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
