import type { RouterConfig } from "../config/types.agent-defaults.js";
import { EscalationPolicy } from "./escalation.js";
import { SignalCollector } from "./signals.js";

const TIER_ORDER = ["low", "medium", "high"] as const;
type Tier = (typeof TIER_ORDER)[number];

export class ModelRouter {
  private currentTierIndex: number;
  private signals: SignalCollector;
  private policy: EscalationPolicy;
  private config: RouterConfig;

  constructor(config: RouterConfig) {
    this.config = config;
    const defaultIndex = TIER_ORDER.indexOf(config.defaultTier ?? "medium");
    this.currentTierIndex = Math.max(0, defaultIndex);
    this.signals = new SignalCollector();
    this.policy = new EscalationPolicy(config);
  }

  getCurrentModel(): string {
    const tier = TIER_ORDER[this.currentTierIndex];
    return this.config.tiers[tier].model;
  }

  getCurrentTier(): Tier {
    return TIER_ORDER[this.currentTierIndex];
  }

  recordRetry(): void {
    this.signals.recordRetry();
  }

  recordToolCall(): void {
    this.signals.recordToolCall();
  }

  recordContextSize(size: number): void {
    this.signals.recordContextSize(size);
  }

  recordError(error: string): void {
    this.signals.recordError(error);
  }

  shouldEscalate(): boolean {
    if (this.currentTierIndex >= TIER_ORDER.length - 1) {
      return false; // Already at highest tier
    }
    return this.policy.shouldEscalate(this.signals.getSignals());
  }

  escalate(): void {
    if (this.currentTierIndex < TIER_ORDER.length - 1) {
      this.currentTierIndex++;
    }
  }
}
