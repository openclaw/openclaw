export const CONTEXT_BROKER_INTENT_VALUES = [
  "prior-work",
  "incident-follow-up",
  "data-integrity-investigation",
  "postgres-internals",
  "repo-deploy-ownership",
  "read-consistency-incident",
  "multi-repo-fix-planning",
] as const;

export type ContextBrokerIntent = (typeof CONTEXT_BROKER_INTENT_VALUES)[number];

export type ContextBrokerClassification = {
  intents: ContextBrokerIntent[];
  reasons: string[];
};

const INTENT_RULES: Array<{
  intent: ContextBrokerIntent;
  reason: string;
  patterns: RegExp[];
}> = [
  {
    intent: "prior-work",
    reason: "prompt references previous work or prior decisions",
    patterns: [
      /\b(previous|prior|earlier|last time|history|what did we do|already fixed)\b/i,
      /\b(decision|decided|agreed|follow[- ]?up from)\b/i,
    ],
  },
  {
    intent: "incident-follow-up",
    reason: "prompt references incident or RCA follow-up",
    patterns: [
      /\b(incident|outage|alert|rca|root cause|postmortem|impact|degraded)\b/i,
      /\b(follow[- ]?up|what happened|customer impact)\b/i,
      /\breported by (several )?integrators\b/i,
    ],
  },
  {
    intent: "data-integrity-investigation",
    reason: "prompt references wrong, stale, or inconsistent data investigation",
    patterns: [
      /\b(data issue|data drift|wrong value|bad value|stale data|incorrect data)\b/i,
      /\b(apy spike|negative apy|nonsense apy|inconsistent value|mixed state)\b/i,
      /\bspike\b.*\bapy\b/i,
      /\bapy\b.*\bspike\b/i,
      /\bapy jumps?\b/i,
      /\b(db table|database row|data row|wrong row|stale row|missing row|query the db|query the database)\b/i,
    ],
  },
  {
    intent: "postgres-internals",
    reason: "prompt references postgres internals or replica health",
    patterns: [
      /\b(pg_stat|pg internal|postgres internals|postgres stats|pg settings)\b/i,
      /\b(replica lag|replay lag|recovery conflict|conflicts with recovery)\b/i,
      /\b(pg_stat_activity|pg_stat_statements|pg_stat_database_conflicts|pg_locks|pg_is_in_recovery)\b/i,
    ],
  },
  {
    intent: "repo-deploy-ownership",
    reason: "prompt asks about repo, deployment, or source-of-truth ownership",
    patterns: [
      /\b(repo|repository|owner(ship)?|source of truth)\b/i,
      /\b(helm|values\.ya?ml|chart|deployment|argocd|manifest)\b/i,
    ],
  },
  {
    intent: "read-consistency-incident",
    reason: "prompt references read-consistency, fanout drift, or mixed backend freshness",
    patterns: [
      /\b(read consistency|consistent read|same snapshot|same backend|same replica)\b/i,
      /\b(load balancing|haproxy|pool connections|promise\.all|fan[- ]?out)\b/i,
      /\b(primary vs replica|mixed freshness|different replay positions|routing drift)\b/i,
    ],
  },
  {
    intent: "multi-repo-fix-planning",
    reason: "prompt asks for coordinated change planning across repos",
    patterns: [
      /\b(multi[- ]?repo|across repos|both repos|coordinate)\b/i,
      /\b(plan|fix plan|change plan|pull request|pr|rollout)\b/i,
    ],
  },
];

export function classifyContextBrokerIntent(prompt: string): ContextBrokerClassification {
  const normalized = prompt.trim();
  if (!normalized) {
    return { intents: [], reasons: [] };
  }

  const intents: ContextBrokerIntent[] = [];
  const reasons: string[] = [];
  for (const rule of INTENT_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(normalized))) {
      intents.push(rule.intent);
      reasons.push(rule.reason);
    }
  }

  return { intents, reasons };
}
