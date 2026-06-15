import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The per-node restriction is a post-filter on top of the existing policy
// pipeline, keyed off the AUTHENTICATED hosting node (set in the node-id
// registry at node-originated agent.request dispatch). We mock the heavyweight
// collaborators so the test isolates the gateway.tools.byNode allow/deny logic.

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

import {
  resetSessionHostingNodeIdsForTest,
  setSessionHostingNodeId,
} from "./session-node-id-registry.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

const NODE = "node-abc";
const SESSION = "agent:main:main";

function names(result: ReturnType<typeof resolveGatewayScopedTools>): string[] {
  return result.tools.map((tool) => tool.name).toSorted();
}

function cfgWith(byNode: Record<string, { allow?: string[]; deny?: string[] }>) {
  return { gateway: { tools: { byNode } } } as never;
}

beforeEach(() => resetSessionHostingNodeIdsForTest());
afterEach(() => resetSessionHostingNodeIdsForTest());

describe("resolveGatewayScopedTools gateway.tools.byNode (authenticated-node restriction)", () => {
  it("intersects the final tools to the hosting node's allow list", () => {
    setSessionHostingNodeId(SESSION, NODE);
    const result = resolveGatewayScopedTools({
      cfg: cfgWith({ [NODE]: { allow: ["browser", "memory_search", "memory_get"] } }),
      sessionKey: SESSION,
    });
    expect(names(result)).toEqual(["browser", "memory_get", "memory_search"]);
  });

  it("cannot escalate: an allow naming an unavailable tool yields nothing extra", () => {
    setSessionHostingNodeId(SESSION, NODE);
    const result = resolveGatewayScopedTools({
      cfg: cfgWith({ [NODE]: { allow: ["browser", "not_a_tool"] } }),
      sessionKey: SESSION,
    });
    expect(names(result)).toEqual(["browser"]);
  });

  it("treats an explicit empty allow as no tools (fail-closed)", () => {
    setSessionHostingNodeId(SESSION, NODE);
    const result = resolveGatewayScopedTools({
      cfg: cfgWith({ [NODE]: { allow: [] } }),
      sessionKey: SESSION,
    });
    expect(names(result)).toEqual([]);
  });

  it("extends the deny set with the node's deny list", () => {
    setSessionHostingNodeId(SESSION, NODE);
    const result = resolveGatewayScopedTools({
      cfg: cfgWith({ [NODE]: { deny: ["nodes", "exec"] } }),
      sessionKey: SESSION,
    });
    expect(names(result)).not.toContain("nodes");
    expect(names(result)).not.toContain("exec");
    expect(names(result)).toContain("browser");
  });

  it("is a no-op when no hosting node is recorded for the session", () => {
    const result = resolveGatewayScopedTools({
      cfg: cfgWith({ [NODE]: { allow: ["browser"] } }),
      sessionKey: SESSION,
    });
    expect(names(result)).toEqual(ALL_TOOLS.map((t) => t.name).toSorted());
  });

  it("is a no-op when the hosting node has no byNode entry", () => {
    setSessionHostingNodeId(SESSION, "some-other-node");
    const result = resolveGatewayScopedTools({
      cfg: cfgWith({ [NODE]: { allow: ["browser"] } }),
      sessionKey: SESSION,
    });
    expect(names(result)).toEqual(ALL_TOOLS.map((t) => t.name).toSorted());
  });
});
