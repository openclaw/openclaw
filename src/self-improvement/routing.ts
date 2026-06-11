import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  SelfImprovementRecommendationCategory,
  SelfImprovementRecommendationRoute,
  SelfImprovementRouteRole,
} from "./types.js";

const DEFAULT_AGENT_LABELS: Record<SelfImprovementRouteRole, string> = {
  todd: "Todd Stanski",
  builder: "Builder Agent",
  qa: "QA Test Agent",
  program_manager: "Program Manager",
  memory_curator: "Memory/Knowledge Curator",
};

function configuredAgentIds(cfg: OpenClawConfig): Set<string> {
  return new Set((cfg.agents?.list ?? []).map((entry) => entry.id).filter(Boolean));
}

function firstConfiguredAgent(
  configured: ReadonlySet<string>,
  candidates: readonly string[],
): string {
  return candidates.find((candidate) => configured.has(candidate)) ?? candidates[0];
}

function routeRoleForCategory(
  category: SelfImprovementRecommendationCategory,
): SelfImprovementRouteRole {
  switch (category) {
    case "smoke_failure":
    case "verification_gap":
    case "risk_prevention":
      return "qa";
    case "model_routing":
    case "task_reliability":
    case "efficiency_opportunity":
    case "architecture_simplification":
      return "builder";
    case "stale_work":
    case "project_health":
    case "workflow_simplification":
    case "agent_minimization":
    case "capability_evolution":
    case "major_change":
      return "program_manager";
    case "skill_workshop":
    case "user_correction":
    case "instruction_adherence":
    case "knowledge_hygiene":
      return "memory_curator";
    case "outcome_measurement":
      return "todd";
  }
}

function routeReason(role: SelfImprovementRouteRole): string {
  switch (role) {
    case "todd":
      return "User-facing synthesis and priority framing.";
    case "builder":
      return "Implementation proposal or code/config remediation planning.";
    case "qa":
      return "Verification gap, smoke failure, or test-proof follow-up.";
    case "program_manager":
      return "Sequencing, stale work triage, and priority coordination.";
    case "memory_curator":
      return "Procedural memory, skill curation, and Skill Workshop review.";
  }
}

export function resolveSelfImprovementRoute(params: {
  cfg: OpenClawConfig;
  category: SelfImprovementRecommendationCategory;
  overrideRole?: SelfImprovementRouteRole;
}): SelfImprovementRecommendationRoute {
  const role = params.overrideRole ?? routeRoleForCategory(params.category);
  const configured = configuredAgentIds(params.cfg);
  const targetAgentId =
    role === "todd"
      ? firstConfiguredAgent(configured, ["main"])
      : role === "builder"
        ? firstConfiguredAgent(configured, ["builder-agent", "codex"])
        : role === "qa"
          ? firstConfiguredAgent(configured, ["qa-test-agent", "telemetry-evaluation-analyst"])
          : role === "program_manager"
            ? firstConfiguredAgent(configured, ["program-manager"])
            : firstConfiguredAgent(configured, ["memory-knowledge-curator"]);
  return {
    role,
    targetAgentId,
    targetAgentLabel: DEFAULT_AGENT_LABELS[role],
    reason: routeReason(role),
  };
}
