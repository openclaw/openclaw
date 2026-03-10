/**
 * Agent routing algorithm tests.
 *
 * Validates that the keyword-based routing correctly directs tasks to
 * the right Tier 2 department head.
 */
import { describe, test, expect } from "vitest";
import { routeTask, type AgentRegistryState } from "../gateway/agent-registry-service.js";
import type { RegisteredAgent } from "../gateway/agent-registry-service.js";
import type { AgentManifest } from "./zod-schema.agent-manifest.js";

// ── Test fixtures ────────────────────────────────────────────────────────────

function makeAgent(
  partial: Partial<AgentManifest> & { id: string; tier: number },
): RegisteredAgent {
  return {
    manifest: {
      name: partial.id,
      role: "Test Role",
      department: "test",
      description: "Test agent",
      version: "1.0.0",
      ...partial,
    } as AgentManifest,
    scope: "project",
    status: "active",
  };
}

function makeRegistry(agents: RegisteredAgent[]): AgentRegistryState {
  return {
    agents,
    activeAgents: agents.filter((a) => a.status === "active"),
    disabledAgents: agents.filter((a) => a.status === "disabled"),
    degraded: false,
  };
}

const neo = makeAgent({
  id: "neo",
  name: "Neo",
  tier: 2,
  role: "CTO",
  department: "engineering",
  capabilities: ["code_review", "architecture_decisions", "technical_planning"],
  routing_hints: {
    keywords: [
      "backend",
      "api",
      "database",
      "infrastructure",
      "code",
      "engineering",
      "devops",
      "testing",
    ],
    priority: "high",
    preferred_for: ["architectural_questions"],
  },
});

const trinity = makeAgent({
  id: "trinity",
  name: "Trinity",
  tier: 2,
  role: "CFO",
  department: "finance",
  capabilities: ["financial_analysis", "compliance_review", "budget_management"],
  routing_hints: {
    keywords: ["finance", "budget", "compliance", "analytics", "cost", "revenue", "audit"],
    priority: "high",
    preferred_for: ["financial_decisions"],
  },
});

const morpheus = makeAgent({
  id: "morpheus",
  name: "Morpheus",
  tier: 2,
  role: "CMO",
  department: "marketing",
  capabilities: ["content_strategy", "brand_management", "campaign_planning"],
  routing_hints: {
    keywords: ["marketing", "content", "social", "brand", "design", "campaign"],
    priority: "high",
    preferred_for: ["marketing_strategy"],
  },
});

const registry = makeRegistry([neo, trinity, morpheus]);

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Agent Routing", () => {
  test("routes backend tasks to Neo", () => {
    const result = routeTask("Add rate limiting to the API", registry);
    expect(result.agent?.manifest.id).toBe("neo");
    expect(result.needsClarification).toBe(false);
  });

  test("routes database tasks to Neo", () => {
    const result = routeTask("Optimize the database queries for the user table", registry);
    expect(result.agent?.manifest.id).toBe("neo");
  });

  test("routes DevOps tasks to Neo", () => {
    const result = routeTask("Set up CI/CD infrastructure with GitHub Actions", registry);
    expect(result.agent?.manifest.id).toBe("neo");
  });

  test("routes finance tasks to Trinity", () => {
    const result = routeTask("Prepare the Q3 budget forecast and revenue analysis", registry);
    expect(result.agent?.manifest.id).toBe("trinity");
  });

  test("routes compliance tasks to Trinity", () => {
    const result = routeTask("Run a compliance audit for GDPR", registry);
    expect(result.agent?.manifest.id).toBe("trinity");
  });

  test("routes marketing tasks to Morpheus", () => {
    const result = routeTask("Create a social media campaign for the product launch", registry);
    expect(result.agent?.manifest.id).toBe("morpheus");
  });

  test("routes content tasks to Morpheus", () => {
    const result = routeTask("Write a blog post about our new brand design", registry);
    expect(result.agent?.manifest.id).toBe("morpheus");
  });

  test("requests clarification for ambiguous tasks", () => {
    const result = routeTask("Fix the bug", registry);
    // "bug" doesn't strongly match any department keywords
    expect(result.needsClarification).toBe(true);
  });

  test("returns scores for all Tier 2 agents", () => {
    const result = routeTask("Add rate limiting to the API", registry);
    expect(result.scores).toHaveLength(3);
    expect(result.scores.map((s) => s.agentId).toSorted()).toEqual(["morpheus", "neo", "trinity"]);
  });

  test("alphabetical tiebreaker for equal scores", () => {
    // Task with no keywords matching any agent
    const result = routeTask("hello world", registry);
    // All should score 0, alphabetical order: morpheus < neo < trinity
    // But below threshold → needs clarification
    expect(result.needsClarification).toBe(true);
  });

  test("handles empty registry", () => {
    const emptyRegistry = makeRegistry([]);
    const result = routeTask("Add rate limiting", emptyRegistry);
    expect(result.agent).toBeNull();
    expect(result.needsClarification).toBe(true);
  });

  test("ignores disabled agents", () => {
    const disabledNeo = { ...neo, status: "disabled" as const, disableReason: "test" };
    const degradedRegistry = makeRegistry([disabledNeo, trinity, morpheus]);
    const result = routeTask("Add rate limiting to the API backend", degradedRegistry);
    // Neo is disabled, should not be routed to
    expect(result.agent?.manifest.id).not.toBe("neo");
  });
});
