import { describe, expect, it } from "vitest";
import {
  applyTurnSurfacePolicyToTools,
  compileTurnSurfacePolicy,
  filterTurnSurfaceRequestedTools,
  isToolAllowedByTurnSurfacePolicy,
} from "./turn-surface-policy.js";

describe("compileTurnSurfacePolicy", () => {
  it("keeps internal finance scope narrowed to finance_research", () => {
    const policy = compileTurnSurfacePolicy({ toolsAllow: ["finance_research"] });
    const tools = [
      { name: "finance_research" },
      { name: "message" },
      { name: "web_search" },
      { name: "memory_search" },
      { name: "jh_report_memory_search_readonly" },
    ];

    expect(policy.toolsAllow).toEqual(["finance_research"]);
    expect(applyTurnSurfacePolicyToTools(tools, policy).map((tool) => tool.name)).toEqual([
      "finance_research",
    ]);
  });

  it("does not allow forced message unless the scoped allowlist includes it", () => {
    const policy = compileTurnSurfacePolicy({
      toolsAllow: ["finance_research"],
      forcedRuntimeToolNames: ["message"],
    });

    expect(policy.toolsAllow).toEqual(["finance_research"]);
    expect(isToolAllowedByTurnSurfacePolicy("message", policy)).toBe(false);
  });

  it("keeps explicit empty allowlists closed", () => {
    const policy = compileTurnSurfacePolicy({
      toolsAllow: [],
      forcedRuntimeToolNames: ["message"],
    });

    expect(policy.enabled).toBe(true);
    expect(policy.toolsAllow).toEqual([]);
    expect(isToolAllowedByTurnSurfacePolicy("message", policy)).toBe(false);
  });

  it("keeps forced message when send scope already resolved to message", () => {
    const policy = compileTurnSurfacePolicy({
      toolsAllow: ["finance_research", "message"],
      forcedRuntimeToolNames: ["message"],
    });

    expect(policy.toolsAllow).toEqual(["finance_research", "message"]);
    expect(isToolAllowedByTurnSurfacePolicy("message", policy)).toBe(true);
  });

  it("filters gateway requested tools before they widen the surface", () => {
    const policy = compileTurnSurfacePolicy({ toolsAllow: ["finance_research"] });

    expect(filterTurnSurfaceRequestedTools(["web_search", "message"], policy)).toEqual([]);
  });

  it("keeps legacy exclude-only policy from enabling default scope deny", () => {
    const policy = compileTurnSurfacePolicy({ excludeToolNames: ["web_search"] });
    const tools = [{ name: "message" }, { name: "web_search" }, { name: "exec" }];

    expect(policy.enabled).toBe(true);
    expect(policy.defaultDenyEnabled).toBe(false);
    expect(applyTurnSurfacePolicyToTools(tools, policy).map((tool) => tool.name)).toEqual([
      "message",
      "exec",
    ]);
  });

  it("preserves legacy behavior when no turn surface policy input is present", () => {
    const policy = compileTurnSurfacePolicy({});

    expect(policy.enabled).toBe(false);
    expect(policy.defaultDenyEnabled).toBe(false);
    expect(filterTurnSurfaceRequestedTools(["message"], policy)).toEqual(["message"]);
  });
});
