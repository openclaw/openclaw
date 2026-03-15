export const REVIEW_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export const REVIEW_RECOMMENDATIONS = ["allow", "warn", "manual_review"] as const;
export const REVIEW_ANALYZERS = [
  "auth-bypass",
  "authorization-idor",
  "rls-alignment",
  "admin-boundary",
  "otp-abuse",
  "webhook-verification",
  "xss-rendering",
  "data-exposure",
  "rate-limiting",
  "input-validation",
] as const;
export const RADAR_ARTIFACT_KINDS = ["code-snippet", "route", "sql-policy", "flow"] as const;
export const RADAR_TOOL_NAMES = [
  "analyze_code_snippet",
  "analyze_route",
  "analyze_sql_policy",
  "threat_model_flow",
  "summarize_finding",
  "review_auth_boundary",
  "review_rls_assumptions",
] as const;
export const TOOL_AUDIENCES = ["engineer", "founder", "support", "auditor"] as const;
export const OUTPUT_MODES = ["json", "markdown"] as const;
export const HIGHEST_SEVERITY_VALUES = ["none", ...REVIEW_SEVERITIES] as const;

export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];
export type ReviewRecommendation = (typeof REVIEW_RECOMMENDATIONS)[number];
export type ReviewAnalyzerName = (typeof REVIEW_ANALYZERS)[number];
export type RadarArtifactKind = (typeof RADAR_ARTIFACT_KINDS)[number];
export type RadarToolName = (typeof RADAR_TOOL_NAMES)[number];
export type ToolAudience = (typeof TOOL_AUDIENCES)[number];
export type ReviewOutputMode = (typeof OUTPUT_MODES)[number];
export type HighestSeverityValue = (typeof HIGHEST_SEVERITY_VALUES)[number];

export const REVIEW_SEVERITY_RANK: Record<ReviewSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

export type ReviewFinding = {
  finding: string;
  severity: ReviewSeverity;
  affected_area: string;
  preconditions: string[];
  why_it_matters: string;
  evidence: string[];
  recommended_fix: string[];
  regression_test_idea: string;
};

export type ReviewSummary = {
  finding_count: number;
  highest_severity: HighestSeverityValue;
  review_recommendation: ReviewRecommendation;
  applied_analyzers: ReviewAnalyzerName[];
};

export type ReviewResult = {
  tool: RadarToolName;
  target: string;
  summary: ReviewSummary;
  findings: ReviewFinding[];
  unverified: string[];
};

export type ReviewArtifactMetadata = Record<string, unknown> & {
  language?: string;
  logicalPath?: string;
  routePath?: string;
  method?: string;
  notes?: string;
  table?: string;
  policyName?: string;
  assumedAccessPattern?: string;
  clientFlow?: string;
  actors?: string[];
  assets?: string[];
  steps?: string[];
  trustBoundaries?: string[];
  apiAssumptionSummary?: string;
};

export type ReviewArtifact = {
  kind: RadarArtifactKind;
  name: string;
  content: string;
  metadata?: ReviewArtifactMetadata;
};

export type ReviewExecution = {
  findings: ReviewFinding[];
  appliedAnalyzers: ReviewAnalyzerName[];
  unverified: string[];
};

export type RadarDefenderServerConfig = {
  name: string;
  transport: "stdio";
};

export type RadarDefenderReviewConfig = {
  minimumSeverity: ReviewSeverity;
  enabledTools: RadarToolName[];
  enabledAnalyzers: ReviewAnalyzerName[];
  outputMode: ReviewOutputMode;
};

export type RadarDefenderConfig = {
  server: RadarDefenderServerConfig;
  review: RadarDefenderReviewConfig;
  contextOverrides: Record<string, unknown>;
};

export type RadarProductContext = {
  productName: string;
  productSummary: string;
  roles: string[];
  coreFlows: string[];
  architectureSummary: string[];
  priorityRiskAreas: string[];
};
