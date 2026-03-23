/**
 * Matrix agent tier hierarchy lookup.
 *
 * Tier 1: Leadership (Operator1/main)
 * Tier 2: Department Heads (Neo, Morpheus, Trinity)
 * Tier 3: Specialists (all others)
 */

export type TierLevel = 1 | 2 | 3;

export interface TierInfo {
  tier: TierLevel;
  label: string;
  color: string;
  parent: string | null;
  children: string[];
  department: string;
}

// Tier 2 agents and their Tier 3 subordinates
const ENGINEERING_AGENTS = [
  "Tank",
  "Dozer",
  "Mouse",
  "Spark",
  "Cipher",
  "Relay",
  "Ghost",
  "Binary",
  "Kernel",
  "Prism",
];
const MARKETING_AGENTS = [
  "Niobe",
  "Switch",
  "Rex",
  "Ink",
  "Vibe",
  "Lens",
  "Echo",
  "Nova",
  "Pulse",
  "Blaze",
];
const FINANCE_AGENTS = [
  "Oracle",
  "Seraph",
  "Zee",
  "Ledger",
  "Vault",
  "Shield",
  "Trace",
  "Quota",
  "Merit",
  "Beacon",
];

const TIER_2_AGENTS = ["Neo", "Morpheus", "Trinity"];
const _TIER_1_AGENTS = ["Operator1", "main"];

const TIER_MAP: Record<string, TierInfo> = {
  // Tier 1
  Operator1: {
    tier: 1,
    label: "Leadership",
    color: "#fbbf24",
    parent: null,
    children: TIER_2_AGENTS,
    department: "operations",
  },
  main: {
    tier: 1,
    label: "Leadership",
    color: "#fbbf24",
    parent: null,
    children: TIER_2_AGENTS,
    department: "operations",
  },
  // Tier 2
  Neo: {
    tier: 2,
    label: "Department Head",
    color: "#94a3b8",
    parent: "Operator1",
    children: ENGINEERING_AGENTS,
    department: "engineering",
  },
  neo: {
    tier: 2,
    label: "Department Head",
    color: "#94a3b8",
    parent: "Operator1",
    children: ENGINEERING_AGENTS,
    department: "engineering",
  },
  Morpheus: {
    tier: 2,
    label: "Department Head",
    color: "#94a3b8",
    parent: "Operator1",
    children: MARKETING_AGENTS,
    department: "marketing",
  },
  morpheus: {
    tier: 2,
    label: "Department Head",
    color: "#94a3b8",
    parent: "Operator1",
    children: MARKETING_AGENTS,
    department: "marketing",
  },
  Trinity: {
    tier: 2,
    label: "Department Head",
    color: "#94a3b8",
    parent: "Operator1",
    children: FINANCE_AGENTS,
    department: "finance",
  },
  trinity: {
    tier: 2,
    label: "Department Head",
    color: "#94a3b8",
    parent: "Operator1",
    children: FINANCE_AGENTS,
    department: "finance",
  },
};

// Build Tier 3 entries
for (const [parent, children, dept] of [
  ["Neo", ENGINEERING_AGENTS, "engineering"],
  ["Morpheus", MARKETING_AGENTS, "marketing"],
  ["Trinity", FINANCE_AGENTS, "finance"],
] as const) {
  for (const name of children) {
    TIER_MAP[name] = {
      tier: 3,
      label: "Specialist",
      color: "#a78bfa",
      parent,
      children: [],
      department: dept,
    };
  }
}

/** Look up tier info for an agent by name (display name). */
export function getAgentTierInfo(agentName: string): TierInfo {
  return (
    TIER_MAP[agentName] ?? {
      tier: 3,
      label: "Specialist",
      color: "#a78bfa",
      parent: null,
      children: [],
      department: "unknown",
    }
  );
}

/** Get tier level (1, 2, or 3) for an agent name. */
export function getAgentTier(agentName: string): TierLevel {
  return getAgentTierInfo(agentName).tier;
}

/** Get the parent agent name, or null for Tier 1. */
export function getAgentParent(agentName: string): string | null {
  return getAgentTierInfo(agentName).parent;
}

/** Get child agent names (subordinates). */
export function getAgentChildren(agentName: string): string[] {
  return getAgentTierInfo(agentName).children;
}

/** Get display label for a tier. */
export function getTierBadgeLabel(tier: TierLevel): string {
  switch (tier) {
    case 1:
      return "T1 Leadership";
    case 2:
      return "T2 Dept Head";
    case 3:
      return "T3 Specialist";
  }
}

/** Get badge color for a tier. */
export function getTierBadgeColor(tier: TierLevel): string {
  switch (tier) {
    case 1:
      return "#fbbf24"; // gold
    case 2:
      return "#94a3b8"; // silver
    case 3:
      return "#a78bfa"; // purple
  }
}

/** Department display colors */
export const DEPARTMENT_COLORS: Record<string, string> = {
  operations: "#fbbf24",
  engineering: "#3b82f6",
  marketing: "#f97316",
  finance: "#10b981",
};
