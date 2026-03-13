export type TopPaymentIntent =
  | "account.current_balance"
  | "account.next_payment_due"
  | "account.last_payment_received"
  | "account.amount_owed"
  | "account.delinquency_status";

export type IntentExecutionMode = "api-first" | "api-first-with-light-llm" | "llm-heavy";

export type IntentRoutingResult = {
  intent: TopPaymentIntent;
  executionMode: IntentExecutionMode;
  confidence: "high" | "medium";
  reason: string;
  requiredApiFields: string[];
};

type IntentRule = {
  intent: TopPaymentIntent;
  requiredApiFields: string[];
  reason: string;
  patterns: RegExp[];
};

const INTENT_RULES: IntentRule[] = [
  {
    intent: "account.current_balance",
    requiredApiFields: ["resident_id", "unit_id", "current_balance", "as_of_timestamp"],
    reason: "Current balance is a direct account lookup from the PM system of record.",
    patterns: [
      /\bcurrent\s+balance\b/i,
      /\bwhat(?:'s|\s+is)\s+my\s+balance\b/i,
      /\bbalance\s+right\s+now\b/i,
    ],
  },
  {
    intent: "account.next_payment_due",
    requiredApiFields: ["resident_id", "unit_id", "next_due_date", "next_due_amount"],
    reason: "Next payment due is deterministic from billing schedule data.",
    patterns: [
      /\bnext\s+(?:hoa\s+)?payment\s+due\b/i,
      /\bwhen\s+is\s+my\s+next\s+payment\s+due\b/i,
      /\bdue\s+date\b/i,
    ],
  },
  {
    intent: "account.last_payment_received",
    requiredApiFields: [
      "resident_id",
      "unit_id",
      "last_payment_amount",
      "last_payment_date",
      "last_payment_status",
    ],
    reason: "Payment receipt/posted status is a transaction-history API check.",
    patterns: [
      /\bdid\s+you\s+receive\s+my\s+last\s+payment\b/i,
      /\breceive[ds]?\s+my\s+payment\b/i,
      /\bdid\s+my\s+check\s+clear\b/i,
      /\blast\s+payment\s+(?:received|posted)\b/i,
    ],
  },
  {
    intent: "account.amount_owed",
    requiredApiFields: ["resident_id", "unit_id", "amount_owed", "as_of_timestamp"],
    reason: "Amount owed is a deterministic AR total from charges, credits, and fees.",
    patterns: [/\bhow\s+much\s+do\s+i\s+owe\b/i, /\bamount\s+owed\b/i, /\bwhat\s+do\s+i\s+owe\b/i],
  },
  {
    intent: "account.delinquency_status",
    requiredApiFields: [
      "resident_id",
      "unit_id",
      "delinquency_status",
      "outstanding_amount",
      "oldest_unpaid_due_date",
    ],
    reason: "Delinquency status is rule-based from due-date and unpaid-balance signals.",
    patterns: [/\bam\s+i\s+delinquent\b/i, /\bdelinquen(?:t|cy)\b/i, /\bpast\s+due\b/i],
  },
];

function normalizeQuery(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}

export function routeTopPaymentIntent(userQuery: string): IntentRoutingResult | null {
  const normalizedQuery = normalizeQuery(userQuery);

  for (const rule of INTENT_RULES) {
    const matchedPattern = rule.patterns.find((pattern) => pattern.test(normalizedQuery));
    if (!matchedPattern) {
      continue;
    }

    return {
      intent: rule.intent,
      executionMode: "api-first",
      confidence: "high",
      reason: rule.reason,
      requiredApiFields: [...rule.requiredApiFields],
    };
  }

  return null;
}

/**
 * Example usage:
 *
 * import { getCurrentBalance } from "./appfolio-api";
 *
 * async function handleCurrentBalanceIntent(residentId: string, unitId: string) {
 *   const data = await getCurrentBalance(residentId, unitId);
 *   // Use data as needed
 * }
 */
