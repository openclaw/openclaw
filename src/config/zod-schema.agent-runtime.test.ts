import { describe, it, expect } from "vitest";
import { MemorySearchSchema } from "./zod-schema.agent-runtime.js";

describe("MemorySearchSchema sharedPaths", () => {
  it("accepts string shorthand", () => {
    const result = MemorySearchSchema.parse({
      sharedPaths: ["~/docs/shared"],
    });
    expect(result!.sharedPaths).toEqual([{ path: "~/docs/shared", weight: 1.0 }]);
  });

  it("accepts object form with weight", () => {
    const result = MemorySearchSchema.parse({
      sharedPaths: [{ path: "~/docs/shared", weight: 1.3 }],
    });
    expect(result!.sharedPaths).toEqual([{ path: "~/docs/shared", weight: 1.3 }]);
  });

  it("defaults weight to 1.0", () => {
    const result = MemorySearchSchema.parse({
      sharedPaths: [{ path: "~/docs/shared" }],
    });
    expect(result!.sharedPaths![0].weight).toBe(1.0);
  });

  it("rejects negative weight", () => {
    expect(() =>
      MemorySearchSchema.parse({
        sharedPaths: [{ path: "~/docs", weight: -1 }],
      }),
    ).toThrow();
  });
});
