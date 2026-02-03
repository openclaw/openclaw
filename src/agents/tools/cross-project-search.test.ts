import { describe, expect, it } from "vitest";
import { crossProjectSearchSchema, validateCrossProjectSearch } from "./cross-project-search.js";

describe("crossProjectSearchSchema", () => {
  it("validates correct input", () => {
    const result = validateCrossProjectSearch({
      project: "backend",
      query: "authentication flow",
    });

    expect(result.valid).toBe(true);
    expect(result.data?.project).toBe("backend");
    expect(result.data?.query).toBe("authentication flow");
  });

  it("rejects missing project", () => {
    const result = validateCrossProjectSearch({
      query: "authentication flow",
    });

    expect(result.valid).toBe(false);
  });

  it("rejects empty query", () => {
    const result = validateCrossProjectSearch({
      project: "backend",
      query: "",
    });

    expect(result.valid).toBe(false);
  });
});
