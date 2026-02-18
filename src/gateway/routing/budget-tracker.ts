import { ModelTier, type BudgetConfig } from "./types.js";

export interface UsageRecord {
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  timestamp: number;
}

export type BudgetTier = "normal" | "warning" | "critical";

/** Known model output prices ($ per 1M output tokens), for cost estimation */
export const MODEL_OUTPUT_COSTS: Record<string, number> = {
  "anthropic/claude-opus-4-6": 25.0,
  "anthropic/claude-sonnet-4-6": 15.0,
  "anthropic/claude-sonnet-4-5": 15.0,
  "anthropic/claude-haiku-4-5": 5.0,
  "minimax/MiniMax-M2.5": 0.0,
  "google-gemini-cli/gemini-2.0-flash": 0.0,
  "google-gemini-cli/gemini-3-flash-preview": 0.0,
  "google-gemini-cli/gemini-3-pro-preview": 0.0,
  "openai-codex/gpt-5.2-codex": 0.0, // OAuth free
  "openai-codex/gpt-5.1": 0.0,
  "openai-codex/gpt-5.1-codex-mini": 0.0,
  "openai-codex/gpt-5.2": 0.0,
};

export class BudgetTracker {
  private config: BudgetConfig;
  private records: UsageRecord[] = [];

  constructor(config: BudgetConfig) {
    this.config = config;
  }

  /** Record a usage event, auto-evicting records older than 24 hours */
  recordUsage(record: UsageRecord): void {
    this.records.push(record);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    this.records = this.records.filter((r) => r.timestamp > cutoff);
  }

  /** Total cost (USD) for today (UTC calendar day) */
  getTodayCost(): number {
    const todayStart = this.getTodayStartMs();
    return this.records
      .filter((r) => r.timestamp >= todayStart)
      .reduce((sum, r) => sum + r.cost_usd, 0);
  }

  /** Total tokens consumed today (prompt + completion) */
  getTodayTokens(): number {
    const todayStart = this.getTodayStartMs();
    return this.records
      .filter((r) => r.timestamp >= todayStart)
      .reduce((sum, r) => sum + r.prompt_tokens + r.completion_tokens, 0);
  }

  /** Current budget pressure tier */
  getBudgetTier(): BudgetTier {
    if (!this.config.enabled) {
      return "normal";
    }

    const costRatio =
      this.config.daily_budget_usd > 0 ? this.getTodayCost() / this.config.daily_budget_usd : 0;
    const tokenRatio =
      this.config.daily_token_limit > 0 ? this.getTodayTokens() / this.config.daily_token_limit : 0;
    const ratio = Math.max(costRatio, tokenRatio);

    if (ratio >= 1.0) {
      return "critical";
    }
    if (ratio >= this.config.warning_threshold) {
      return "warning";
    }
    return "normal";
  }

  /** Suggested starting ModelTier based on current budget pressure */
  getSuggestedStartTier(): ModelTier {
    const tier = this.getBudgetTier();
    if (tier === "critical") {
      return ModelTier.TIER3;
    }
    if (tier === "warning") {
      return ModelTier.TIER2;
    }
    return ModelTier.TIER1;
  }

  /** True when critical + critical_action === "block" */
  shouldBlock(): boolean {
    return this.getBudgetTier() === "critical" && this.config.critical_action === "block";
  }

  /** Returns fallback_model if configured */
  getFallbackModel(): string | undefined {
    return this.config.fallback_model;
  }

  /** Budget usage as a percentage (0–100+) */
  getUsagePercent(): number {
    const costRatio =
      this.config.daily_budget_usd > 0 ? this.getTodayCost() / this.config.daily_budget_usd : 0;
    const tokenRatio =
      this.config.daily_token_limit > 0 ? this.getTodayTokens() / this.config.daily_token_limit : 0;
    return Math.round(Math.max(costRatio, tokenRatio) * 100);
  }

  /** Clear all records (for daily reset or testing) */
  reset(): void {
    this.records = [];
  }

  /** Serialize records to JSON string */
  serialize(): string {
    return JSON.stringify(this.records);
  }

  /** Restore records from JSON string, evicting stale entries */
  deserialize(data: string): void {
    try {
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        this.records = parsed as UsageRecord[];
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        this.records = this.records.filter((r) => r.timestamp > cutoff);
      }
    } catch {
      this.records = [];
    }
  }

  private getTodayStartMs(): number {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  }
}
