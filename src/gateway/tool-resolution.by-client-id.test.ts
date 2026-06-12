import { describe, expect, it, vi } from "vitest";

// The per-client-id restriction is a pure post-filter on top of the existing
// policy pipeline. We mock the heavyweight collaborators so the test isolates
// the new allow/deny intersection behaviour in resolveGatewayScopedTools and
// the registry-driven plumbing in McpLoopbackToolCache.

type MockTool = { name: string; ownerOnly?: boolean };

const ALL_TOOLS: MockTool[] = [
  { name: "browser" },
  { name: "memory_search" },
  { name: "memory_get" },
  { name: "nodes", ownerOnly: true },
  { name: "exec" },
  { name: "message" },
];

vi.mock("../agents/openclaw-tools.js", () => ({
  createOpenClawTools: () => ALL_TOOLS.map((tool) => ({ ...tool })),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: () => "/tmp/ws",
  resolveDefaultAgentId: () => "main",
}));

vi.mock("../agents/pi-tools.policy.js", () => ({
  resolveEffectiveToolPolicy: () => ({ agentId: "main" }),
  resolveGroupToolPolicy: () => undefined,
  resolveSubagentToolPolicyForSession: () => undefined,
}));

vi.mock("../agents/subagent-capabilities.js", () => ({
  isSubagentEnvelopeSession: () => false,
  resolveSubagentCapabilityStore: () => undefined,
}));

// The pipeline is identity for these tests: it returns the tools untouched so we
// can assert purely on the gatewayDeny + allow/deny restriction layers.
vi.mock("../agents/tool-policy-pipeline.js", () => ({
  applyToolPolicyPipeline: ({ tools }: { tools: MockTool[] }) => tools,
  buildDefaultToolPolicyPipelineSteps: () => [],
}));

vi.mock("../agents/tool-policy.js", () => ({
  collectExplicitAllowlist: () => undefined,
  mergeAlsoAllowPolicy: () => undefined,
  resolveToolProfilePolicy: () => undefined,
}));

vi.mock("../plugins/tools.js", () => ({
  getPluginToolMeta: () => undefined,
}));

vi.mock("../logger.js", () => ({
  logWarn: () => {},
}));

vi.mock("../security/dangerous-tools.js", () => ({
  DEFAULT_GATEWAY_HTTP_TOOL_DENY: [],
}));

import { resolveGatewayScopedTools } from "./tool-resolution.js";

const cfg = {} as never;

function names(result: ReturnType<typeof resolveGatewayScopedTools>): string[] {
  return result.tools.map((tool) => tool.name).toSorted();
}

describe("resolveGatewayScopedTools allowToolNames (restriction-only)", () => {
  it("intersects the final tools to only the allow list", () => {
    const result = resolveGatewayScopedTools({
      cfg,
      sessionKey: "agent:main:main",
      allowToolNames: ["browser", "memory_search", "memory_get"],
    });
    expect(names(result)).toEqual(["browser", "memory_get", "memory_search"]);
  });

  it("cannot escalate: an allow naming an unavailable tool yields nothing extra", () => {
    const result = resolveGatewayScopedTools({
      cfg,
      sessionKey: "agent:main:main",
      // "not_a_tool" is not produced by the policy pipeline, so it can never appear.
      allowToolNames: ["browser", "not_a_tool"],
    });
    expect(names(result)).toEqual(["browser"]);
  });

  it("is a no-op when allowToolNames is empty/omitted", () => {
    const withEmpty = resolveGatewayScopedTools({
      cfg,
      sessionKey: "agent:main:main",
      allowToolNames: [],
    });
    const omitted = resolveGatewayScopedTools({ cfg, sessionKey: "agent:main:main" });
    expect(names(withEmpty)).toEqual(names(omitted));
    // Full toolset is returned unchanged.
    expect(names(omitted)).toEqual(ALL_TOOLS.map((t) => t.name).toSorted());
  });

  it("still applies excludeToolNames alongside the allow intersection", () => {
    const result = resolveGatewayScopedTools({
      cfg,
      sessionKey: "agent:main:main",
      allowToolNames: ["browser", "exec"],
      excludeToolNames: ["exec"],
    });
    expect(names(result)).toEqual(["browser"]);
  });
});
