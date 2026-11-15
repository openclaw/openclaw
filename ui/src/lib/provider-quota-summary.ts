import type { ModelAuthStatusResult } from "../api/types.ts";

export type ProviderUsageDisplayProps = {
  basePath?: string;
  modelAuthStatusResult?: ModelAuthStatusResult | null;
};

type QuotaLimitSummary = {
  label: string;
  usedPercent: number;
  resetAt?: number;
};

type QuotaBudgetSummary = {
  label?: string;
  used: number;
  limit: number;
  unit: string;
};

export type ProviderQuotaGroup = {
  providers: string[];
  displayName: string;
  plan?: string;
  accountEmail?: string;
  windows: QuotaLimitSummary[];
  budgets: QuotaBudgetSummary[];
};

export type ProviderQuotaSelection =
  | { status: "known"; group: ProviderQuotaGroup }
  | { status: "unknown" | "unavailable"; group?: never };
