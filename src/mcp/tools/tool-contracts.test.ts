import { describe, expect, it } from "vitest";
import * as z from "zod/v4";
import { analyzeCodeSnippetTool } from "./analyze-code-snippet.js";
import { analyzeRouteTool } from "./analyze-route.js";
import { analyzeSqlPolicyTool } from "./analyze-sql-policy.js";
import { reviewAuthBoundaryTool } from "./review-auth-boundary.js";
import { reviewRlsAssumptionsTool } from "./review-rls-assumptions.js";
import { summarizeFindingTool } from "./summarize-finding.js";
import { threatModelFlowTool } from "./threat-model-flow.js";

const toolDefinitions = [
  {
    tool: analyzeCodeSnippetTool,
    sample: { snippet: "const x = 1;" },
  },
  {
    tool: analyzeRouteTool,
    sample: {
      method: "POST",
      route_path: "/api/test",
      handler_source: "return Response.json({ ok: true });",
    },
  },
  {
    tool: analyzeSqlPolicyTool,
    sample: { table: "jobs", sql: "create policy test on jobs using (auth.uid() = owner_id);" },
  },
  {
    tool: threatModelFlowTool,
    sample: {
      flow_name: "OTP signup",
      actors: ["homeowner", "system"],
      assets: ["user account", "otp token"],
      steps: ["owner requests signup", "system sends otp"],
    },
  },
  {
    tool: summarizeFindingTool,
    sample: {
      audience: "engineer",
      finding: {
        finding: "Raw error.message exposure detected",
        severity: "medium",
        affected_area: "POST /api/auth/register",
        preconditions: ["Dependency throws detailed exception"],
        why_it_matters: "Internal details may leak.",
        evidence: ["Route returns error.message"],
        recommended_fix: ["Replace with fixed message"],
        regression_test_idea: "Assert stable error string",
      },
    },
  },
  {
    tool: reviewAuthBoundaryTool,
    sample: {
      route_path: "/api/admin/jobs/[id]",
      handler_source: "return Response.json({ ok: true });",
    },
  },
  {
    tool: reviewRlsAssumptionsTool,
    sample: {
      table: "jobs",
      policy_sql: "create policy jobs_owner_policy on jobs using (true);",
      api_assumption_summary: "Only owners should read jobs.",
    },
  },
];

describe("Radar MCP tool contracts", () => {
  it("validates each tool input schema and exposes the expected output keys", () => {
    for (const definition of toolDefinitions) {
      const inputSchema = z.object(definition.tool.inputSchema);
      expect(() => inputSchema.parse(definition.sample)).not.toThrow();

      const outputSchema = z.object(definition.tool.outputSchema);
      if (definition.tool.name === "summarize_finding") {
        expect(outputSchema.shape).toHaveProperty("audience");
        expect(outputSchema.shape).toHaveProperty("summary");
        expect(outputSchema.shape).toHaveProperty("source_finding");
      } else {
        expect(outputSchema.shape).toHaveProperty("tool");
        expect(outputSchema.shape).toHaveProperty("target");
        expect(outputSchema.shape).toHaveProperty("summary");
        expect(outputSchema.shape).toHaveProperty("findings");
        expect(outputSchema.shape).toHaveProperty("unverified");
      }
    }
  });
});
