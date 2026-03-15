import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEFAULT_RADAR_DEFENDER_CONFIG } from "../context/radar-defaults.js";
import type { RadarDefenderConfig, RadarToolName } from "../core/types.js";
import { analyzeCodeSnippetTool } from "./tools/analyze-code-snippet.js";
import { analyzeRouteTool } from "./tools/analyze-route.js";
import { analyzeSqlPolicyTool } from "./tools/analyze-sql-policy.js";
import { reviewAuthBoundaryTool } from "./tools/review-auth-boundary.js";
import { reviewRlsAssumptionsTool } from "./tools/review-rls-assumptions.js";
import { summarizeFindingTool } from "./tools/summarize-finding.js";
import { threatModelFlowTool } from "./tools/threat-model-flow.js";

export const RADAR_MCP_TOOL_DEFINITIONS = [
  analyzeCodeSnippetTool,
  analyzeRouteTool,
  analyzeSqlPolicyTool,
  threatModelFlowTool,
  summarizeFindingTool,
  reviewAuthBoundaryTool,
  reviewRlsAssumptionsTool,
] as const;

function registerAnalyzeCodeSnippet(server: McpServer, config: RadarDefenderConfig) {
  server.registerTool(
    analyzeCodeSnippetTool.name,
    {
      description: analyzeCodeSnippetTool.description,
      inputSchema: analyzeCodeSnippetTool.inputSchema,
      outputSchema: analyzeCodeSnippetTool.outputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (args) => analyzeCodeSnippetTool.execute(args, config),
  );
}

function registerAnalyzeRoute(server: McpServer, config: RadarDefenderConfig) {
  server.registerTool(
    analyzeRouteTool.name,
    {
      description: analyzeRouteTool.description,
      inputSchema: analyzeRouteTool.inputSchema,
      outputSchema: analyzeRouteTool.outputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (args) => analyzeRouteTool.execute(args, config),
  );
}

function registerAnalyzeSqlPolicy(server: McpServer, config: RadarDefenderConfig) {
  server.registerTool(
    analyzeSqlPolicyTool.name,
    {
      description: analyzeSqlPolicyTool.description,
      inputSchema: analyzeSqlPolicyTool.inputSchema,
      outputSchema: analyzeSqlPolicyTool.outputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (args) => analyzeSqlPolicyTool.execute(args, config),
  );
}

function registerThreatModelFlow(server: McpServer, config: RadarDefenderConfig) {
  server.registerTool(
    threatModelFlowTool.name,
    {
      description: threatModelFlowTool.description,
      inputSchema: threatModelFlowTool.inputSchema,
      outputSchema: threatModelFlowTool.outputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (args) => threatModelFlowTool.execute(args, config),
  );
}

function registerSummarizeFinding(server: McpServer, config: RadarDefenderConfig) {
  server.registerTool(
    summarizeFindingTool.name,
    {
      description: summarizeFindingTool.description,
      inputSchema: summarizeFindingTool.inputSchema,
      outputSchema: summarizeFindingTool.outputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (args) => summarizeFindingTool.execute(args, config),
  );
}

function registerReviewAuthBoundary(server: McpServer, config: RadarDefenderConfig) {
  server.registerTool(
    reviewAuthBoundaryTool.name,
    {
      description: reviewAuthBoundaryTool.description,
      inputSchema: reviewAuthBoundaryTool.inputSchema,
      outputSchema: reviewAuthBoundaryTool.outputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (args) => reviewAuthBoundaryTool.execute(args, config),
  );
}

function registerReviewRlsAssumptions(server: McpServer, config: RadarDefenderConfig) {
  server.registerTool(
    reviewRlsAssumptionsTool.name,
    {
      description: reviewRlsAssumptionsTool.description,
      inputSchema: reviewRlsAssumptionsTool.inputSchema,
      outputSchema: reviewRlsAssumptionsTool.outputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (args) => reviewRlsAssumptionsTool.execute(args, config),
  );
}

function registerEnabledTools(server: McpServer, config: RadarDefenderConfig) {
  const toolRegistry: Record<RadarToolName, () => void> = {
    analyze_code_snippet: () => registerAnalyzeCodeSnippet(server, config),
    analyze_route: () => registerAnalyzeRoute(server, config),
    analyze_sql_policy: () => registerAnalyzeSqlPolicy(server, config),
    threat_model_flow: () => registerThreatModelFlow(server, config),
    summarize_finding: () => registerSummarizeFinding(server, config),
    review_auth_boundary: () => registerReviewAuthBoundary(server, config),
    review_rls_assumptions: () => registerReviewRlsAssumptions(server, config),
  };

  for (const toolName of config.review.enabledTools) {
    toolRegistry[toolName]();
  }
}

export function createRadarDefenderMcpServer(
  config: RadarDefenderConfig = DEFAULT_RADAR_DEFENDER_CONFIG,
) {
  const server = new McpServer(
    {
      name: config.server.name,
      version: "0.1.0",
    },
    {
      capabilities: {
        logging: {},
      },
      instructions:
        "Radar Defensive Security Analyst. Defensive review only. Accept supplied artifacts, return structured findings, never execute offensive or live-target actions.",
    },
  );

  registerEnabledTools(server, config);

  return server;
}
