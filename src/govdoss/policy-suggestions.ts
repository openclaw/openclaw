import { buildGovdossPolicyLearningReport, type GovdossPolicyLearningReport } from "./policy-learning.js";

export type GovdossSuggestedPolicy = {
  tenantId?: string;
  createdAt: number;
  report: GovdossPolicyLearningReport;
  status: "proposed" | "accepted" | "rejected";
};

export class GovdossPolicySuggestionRegistry {
  private readonly suggestions = new Map<string, GovdossSuggestedPolicy>();

  generate(tenantId?: string): GovdossSuggestedPolicy {
    const report = buildGovdossPolicyLearningReport({ tenantId, limit: 500 });
    const suggestion: GovdossSuggestedPolicy = {
      tenantId,
      createdAt: Date.now(),
      report,
      status: "proposed",
    };
    this.suggestions.set(tenantId || "global", suggestion);
    return suggestion;
  }

  get(tenantId?: string): GovdossSuggestedPolicy | null {
    return this.suggestions.get(tenantId || "global") ?? null;
  }

  accept(tenantId?: string): GovdossSuggestedPolicy | null {
    const existing = this.get(tenantId);
    if (!existing) return null;
    existing.status = "accepted";
    this.suggestions.set(tenantId || "global", existing);
    return existing;
  }

  reject(tenantId?: string): GovdossSuggestedPolicy | null {
    const existing = this.get(tenantId);
    if (!existing) return null;
    existing.status = "rejected";
    this.suggestions.set(tenantId || "global", existing);
    return existing;
  }
}

export const govdossPolicySuggestionRegistry = new GovdossPolicySuggestionRegistry();
