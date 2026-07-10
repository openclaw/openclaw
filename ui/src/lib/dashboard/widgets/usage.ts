// builtin:usage — a today/window cost + tokens mini-summary over `usage.cost`.
// Binding value shape: `{ totals: CostUsageTotals, days?: number }` (see
// src/infra/session-cost-usage.types.ts). Thin re-implementation — the usage
// page's own view fns are welded to its filter state.

import { html, type TemplateResult } from "lit";
import { t } from "../../../i18n/index.ts";
import { formatCost, formatTokens } from "../../format.ts";
import type { DashboardWidget } from "../types.ts";
import { isRecord, toFiniteNumber } from "./types.ts";

export type UsageModel = {
  cost: number;
  tokens: number;
  days: number | null;
};

export function mapUsage(_widget: DashboardWidget, value: unknown): UsageModel {
  const totals = isRecord(value) && isRecord(value.totals) ? value.totals : {};
  const cost = toFiniteNumber(totals.totalCost) ?? 0;
  const tokens = toFiniteNumber(totals.totalTokens) ?? 0;
  const days = isRecord(value) ? (toFiniteNumber(value.days) ?? null) : null;
  return { cost, tokens, days };
}

export function renderUsage(widget: DashboardWidget, value: unknown): TemplateResult {
  const model = mapUsage(widget, value);
  return html`
    <div class="dashboard-usage" data-test-id="dashboard-usage">
      <div class="dashboard-usage__metric">
        <div class="dashboard-usage__value">${formatCost(model.cost)}</div>
        <div class="dashboard-usage__label">${t("dashboard.widget.usage.cost")}</div>
      </div>
      <div class="dashboard-usage__metric">
        <div class="dashboard-usage__value">${formatTokens(model.tokens)}</div>
        <div class="dashboard-usage__label">${t("dashboard.widget.usage.tokens")}</div>
      </div>
    </div>
  `;
}
