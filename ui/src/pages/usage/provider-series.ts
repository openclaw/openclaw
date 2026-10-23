// Per-provider daily series for the Usage chart's "By provider" mode.
import type { SessionDailyModelUsage } from "../../../../src/infra/session-cost-usage.types.js";
import { canonicalModelAuthProviderId } from "../../lib/model-auth.ts";

/** Fixed slots keep a provider's color stable across ranges and filters. */
const PROVIDER_SLOTS: Record<string, number> = {
  openai: 1,
  anthropic: 2,
  xai: 3,
  "github-copilot": 4,
  google: 5,
};
const SERIES_SLOTS = 5;

/** Series hues are base.css chart tokens; slot 0 is the shared "other" tone. */
const SLOT_COLORS = [
  "var(--oc-border-strong)",
  "var(--chart-series-1)",
  "var(--chart-series-2)",
  "var(--chart-series-3)",
  "var(--chart-series-4)",
  "var(--chart-series-5)",
];

export type ProviderSeries = {
  id: string;
  color: string;
  tokens: number;
  byDate: Map<string, { tokens: number; cost: number }>;
};

export function buildProviderSeries(rows: readonly SessionDailyModelUsage[]): ProviderSeries[] {
  const providers = new Map<string, ProviderSeries>();
  for (const row of rows) {
    const id = canonicalModelAuthProviderId(row.provider ?? "") || (row.provider ?? "");
    let series = providers.get(id);
    if (!series) {
      series = { id, color: "", tokens: 0, byDate: new Map() };
      providers.set(id, series);
    }
    const day = series.byDate.get(row.date) ?? { tokens: 0, cost: 0 };
    day.tokens += row.tokens;
    day.cost += row.cost;
    series.byDate.set(row.date, day);
    series.tokens += row.tokens;
  }
  const ranked = [...providers.values()].toSorted(
    (a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id),
  );
  // Known providers keep their slot; others take free slots by volume, then share "other".
  const free = Array.from({ length: SERIES_SLOTS }, (_, index) => index + 1).filter(
    (slot) => !ranked.some((series) => PROVIDER_SLOTS[series.id] === slot),
  );
  for (const series of ranked) {
    series.color = SLOT_COLORS[PROVIDER_SLOTS[series.id] ?? free.shift() ?? 0]!;
  }
  return ranked;
}
