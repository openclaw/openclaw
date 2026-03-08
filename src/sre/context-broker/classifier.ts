export const CONTEXT_BROKER_INTENT_VALUES = [
  "prior-work",
  "incident-follow-up",
  "repo-deploy-ownership",
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
