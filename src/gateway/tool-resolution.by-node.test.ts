import { describe, expect, it, vi } from "vitest";

// gateway.tools.byNode is a RUN-SCOPED restriction enforced in the embedded
// agent tool builder (createOpenClawCodingTools), where the authenticated hosting
// node id is threaded through the run. resolveGatewayScopedTools serves non-node
// MCP/HTTP callers (no hosting node), so byNode is a no-op here.

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
vi.mock("../agents/agent-tools.policy.js", () => ({
  resolveEffectiveToolPolicy: () => ({ agentId: "main" }),
  resolveGroupToolPolicy: () => undefined,
  resolveInheritedToolPolicyForSession: () => undefined,
  resolveSubagentToolPolicyForSession: () => undefined,
}));
vi.mock("../agents/subagent-capabilities.js", () => ({
  isSubagentEnvelopeSession: () => false,
  resolveSubagentCapabilityStore: () => undefined,
}));
vi.mock("../agents/tool-policy-pipeline.js", () => ({
  applyToolPolicyPipeline: ({ tools }: { tools: MockTool[] }) => tools,
  buildDefaultToolPolicyPipelineSteps: () => [],
}));
vi.mock("../agents/tool-policy.js", () => ({
  collectExplicitAllowlist: () => undefined,
  collectExplicitDenylist: () => [],
  hasRestrictiveAllowPolicy: () => false,
  mergeAlsoAllowPolicy: () => undefined,
  replaceWithEffectiveToolAllowlist: () => {},
  resolveToolProfilePolicy: () => undefined,
}));
vi.mock("../plugins/tools.js", () => ({ getPluginToolMeta: () => undefined }));
vi.mock("../logger.js", () => ({ logWarn: () => {} }));
vi.mock("../security/dangerous-tools.js", () => ({
  DEFAULT_GATEWAY_HTTP_TOOL_DENY: [],
  GATEWAY_OWNER_ONLY_CORE_TOOLS: [],
}));

import { resolveGatewayScopedTools } from "./tool-resolution.js";

const NODE = "node-abc";
const SESSION = "agent:main:main";

function names(result: ReturnType<typeof resolveGatewayScopedTools>): string[] {
  return result.tools.map((tool) => tool.name).toSorted();
}

function cfgWith(byNode: Record<string, { allow?: string[]; deny?: string[] }>) {
  return { gateway: { tools: { byNode } } } as never;
}

describe("resolveGatewayScopedTools gateway.tools.byNode", () => {
  it("is a no-op for non-node MCP/HTTP callers (run-scoped byNode is enforced in the embedded agent tool builder, not this resolver)", () => {
    const result = resolveGatewayScopedTools({
      cfg: cfgWith({ [NODE]: { allow: ["browser"] } }),
      sessionKey: SESSION,
    });
    expect(names(result)).toEqual(ALL_TOOLS.map((t) => t.name).toSorted());
  });
});
