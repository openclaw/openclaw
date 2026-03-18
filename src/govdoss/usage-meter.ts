import type { GovdossPlanTier } from "./tenant-context.js";

export type GovdossMeterEvent = {
  tenantId: string;
  workspaceId?: string;
  billingAccountId?: string;
  planTier: GovdossPlanTier;
  category: "request" | "approval" | "resume" | "execution";
  method?: string;
  riskTier?: "LOW" | "MEDIUM" | "HIGH";
  units: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
};

export class GovdossUsageMeter {
  private readonly events: GovdossMeterEvent[] = [];

  record(event: Omit<GovdossMeterEvent, "timestamp">): GovdossMeterEvent {
    const next: GovdossMeterEvent = {
      ...event,
      timestamp: Date.now(),
    };
    this.events.push(next);
    return next;
  }

  listByTenant(tenantId: string): GovdossMeterEvent[] {
    return this.events.filter((event) => event.tenantId === tenantId);
  }

  summarizeTenant(tenantId: string): {
    totalUnits: number;
    byCategory: Record<string, number>;
  } {
    const filtered = this.listByTenant(tenantId);
    const byCategory: Record<string, number> = {};
    let totalUnits = 0;
    for (const event of filtered) {
      byCategory[event.category] = (byCategory[event.category] ?? 0) + event.units;
      totalUnits += event.units;
    }
    return { totalUnits, byCategory };
  }
}

export const govdossUsageMeter = new GovdossUsageMeter();
