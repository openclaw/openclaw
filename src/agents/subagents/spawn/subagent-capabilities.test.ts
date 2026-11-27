/**
 * Regression coverage for depth-derived subagent capabilities.
 * Verifies main/orchestrator/leaf role and control-scope decisions.
 */
import { describe, expect, it, vi } from "vitest";
import { resolveSubagentCapabilities } from "./subagent-capabilities.js";

// mock-isolation: policy checks also run in catalog workers that do not edit transcripts.
vi.mock("../../../config/sessions/session-accessor.js", () => {
  throw new Error("Subagent capability checks loaded transcript mutation code");
});

describe("resolveSubagentCapabilities", () => {
  it("returns normalized depth for non-finite direct inputs", () => {
    expect(
      resolveSubagentCapabilities({
        depth: Number.NaN,
        maxSpawnDepth: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({
      depth: 0,
      role: "main",
      controlScope: "children",
    });
  });

  it("floors finite depth and max depth consistently", () => {
    expect(resolveSubagentCapabilities({ depth: 1.9, maxSpawnDepth: 1.2 })).toEqual({
      depth: 1,
      role: "leaf",
      controlScope: "none",
    });
  });

  it("makes children at the default recursion boundary leaves", () => {
    expect(resolveSubagentCapabilities({ depth: 1_000 })).toEqual({
      depth: 1_000,
      role: "leaf",
      controlScope: "none",
    });
  });
});
