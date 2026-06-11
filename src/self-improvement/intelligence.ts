import { deriveSelfImprovementGroupActionability } from "./actionability.js";
import type {
  SelfImprovementIntelligenceBucket,
  SelfImprovementIntelligenceOpportunity,
  SelfImprovementIntelligenceSummary,
  SelfImprovementRecommendation,
  SelfImprovementRecommendationCategory,
  SelfImprovementRecommendationGroup,
  SelfImprovementRecommendationSeverity,
  SelfImprovementRouteRole,
  SelfImprovementScorecardBucket,
} from "./types.js";

const INTELLIGENCE_CATEGORIES = new Set<SelfImprovementRecommendationCategory>([
  "efficiency_opportunity",
  "instruction_adherence",
  "workflow_simplification",
  "agent_minimization",
  "capability_evolution",
  "knowledge_hygiene",
  "architecture_simplification",
  "risk_prevention",
  "outcome_measurement",
  "major_change",
]);

const SEVERITY_ORDER: Record<SelfImprovementRecommendationSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function label(value: string): string {
  return value.replace(/_/g, " ");
}

function isHighCritical(priority: SelfImprovementRecommendationSeverity): boolean {
  return priority === "critical" || priority === "high";
}

export function isSelfImprovementIntelligenceCategory(
  category: SelfImprovementRecommendationCategory,
): boolean {
  return INTELLIGENCE_CATEGORIES.has(category);
}

export function selfImprovementIntelligenceCategories(): SelfImprovementRecommendationCategory[] {
  return [...INTELLIGENCE_CATEGORIES];
}

function countRoutes(
  groups: readonly SelfImprovementRecommendationGroup[],
): SelfImprovementScorecardBucket[] {
  const counts = new Map<SelfImprovementRouteRole, number>();
  for (const group of groups) {
    counts.set(group.route.role, (counts.get(group.route.role) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, label: label(key), count }))
    .toSorted((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function buildBuckets(
  groups: readonly SelfImprovementRecommendationGroup[],
): SelfImprovementIntelligenceBucket[] {
  const byCategory = new Map<
    SelfImprovementRecommendationCategory,
    SelfImprovementRecommendationGroup[]
  >();
  for (const group of groups) {
    byCategory.set(group.category, [...(byCategory.get(group.category) ?? []), group]);
  }
  return [...byCategory.entries()]
    .map(([category, categoryGroups]) => ({
      category,
      label: label(category),
      count: categoryGroups.reduce((sum, group) => sum + Math.max(1, group.count), 0),
      highCritical: categoryGroups.filter((group) => isHighCritical(group.priority)).length,
      routes: countRoutes(categoryGroups),
    }))
    .toSorted(
      (left, right) =>
        right.highCritical - left.highCritical ||
        right.count - left.count ||
        left.label.localeCompare(right.label),
    );
}

function toOpportunity(
  group: SelfImprovementRecommendationGroup,
  now: number,
): SelfImprovementIntelligenceOpportunity {
  const actionability =
    group.actionability ?? deriveSelfImprovementGroupActionability(group, [], now);
  return {
    id: group.id,
    title: group.title,
    category: group.category,
    priority: group.priority,
    route: group.route,
    count: group.count,
    confidence: group.analysis.confidence,
    firstSeenAt: group.firstSeenAt,
    lastSeenAt: group.lastSeenAt,
    ageMs: Math.max(0, now - group.firstSeenAt),
    recommendedAction: group.recommendedAction,
    blockers: actionability.blockers.slice(0, 3),
  };
}

function topByCategories(
  groups: readonly SelfImprovementRecommendationGroup[],
  categories: readonly SelfImprovementRecommendationCategory[],
  now: number,
  limit: number,
): SelfImprovementIntelligenceOpportunity[] {
  const categorySet = new Set(categories);
  return groups
    .filter((group) => categorySet.has(group.category))
    .slice(0, limit)
    .map((group) => toOpportunity(group, now));
}

export function buildSelfImprovementIntelligenceSummary(params: {
  recommendations: readonly SelfImprovementRecommendation[];
  groups: readonly SelfImprovementRecommendationGroup[];
  now: number;
}): SelfImprovementIntelligenceSummary {
  const intelligenceGroups = params.groups.filter((group) =>
    isSelfImprovementIntelligenceCategory(group.category),
  );
  const rankedGroups = intelligenceGroups.toSorted(
    (left, right) =>
      SEVERITY_ORDER[right.priority] - SEVERITY_ORDER[left.priority] ||
      right.count - left.count ||
      right.lastSeenAt - left.lastSeenAt ||
      left.title.localeCompare(right.title),
  );
  const highCritical = rankedGroups.filter((group) => isHighCritical(group.priority));
  const staleCutoff = params.now - 7 * 24 * 60 * 60_000;
  return {
    generatedAt: params.now,
    total: intelligenceGroups.reduce((sum, group) => sum + Math.max(1, group.count), 0),
    highCritical: highCritical.length,
    requiresApproval: intelligenceGroups.filter((group) => group.requiresApproval).length,
    requiresTests: intelligenceGroups.filter((group) => group.requiresTests).length,
    byCategory: buildBuckets(intelligenceGroups),
    topOpportunities: rankedGroups.slice(0, 6).map((group) => toOpportunity(group, params.now)),
    stalePatterns: rankedGroups
      .filter((group) => group.lastSeenAt <= staleCutoff)
      .slice(0, 5)
      .map((group) => toOpportunity(group, params.now)),
    instructionThemes: topByCategories(
      rankedGroups,
      ["instruction_adherence", "knowledge_hygiene"],
      params.now,
      5,
    ),
    simplificationCandidates: topByCategories(
      rankedGroups,
      [
        "efficiency_opportunity",
        "workflow_simplification",
        "agent_minimization",
        "architecture_simplification",
      ],
      params.now,
      5,
    ),
    majorChangeCandidates: topByCategories(
      rankedGroups,
      ["capability_evolution", "major_change"],
      params.now,
      5,
    ),
    outcomeMetricGaps: topByCategories(rankedGroups, ["outcome_measurement"], params.now, 5),
  };
}
