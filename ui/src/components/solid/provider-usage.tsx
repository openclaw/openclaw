// Shared provider usage content; surrounding card headers remain surface-owned.
import { For } from "solid-js";
import type {
  ProviderUsageSnapshot,
  UsageWindow,
} from "../../../../src/infra/provider-usage.types.js";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { formatCompactTokenCount } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";

export type ProviderUsageDetails = Pick<
  ProviderUsageSnapshot,
  "windows" | "billing" | "costHistory" | "summary" | "error"
>;

export type ProviderUsageDetailsOptions = {
  groupWindows?: boolean;
};

function windowRank(label: string): number {
  if (/\b\d+(?:m|h)\b/iu.test(label) && !/\b168h\b/iu.test(label)) {
    return 0;
  }
  return /\b(?:week|168h)\b/iu.test(label) ? 1 : 2;
}

function groupUsageWindows(windows: UsageWindow[]): Map<string, UsageWindow[]> {
  const groups = new Map<string, UsageWindow[]>();
  for (const window of windows) {
    const label = window.groupLabel ?? "";
    const group = groups.get(label) ?? [];
    group.push(window);
    groups.set(label, group);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => windowRank(left.label) - windowRank(right.label));
  }
  return groups;
}

function createProviderAmountFormatter(unit: string): (amount: number) => string {
  const normalizedUnit = unit.trim().toUpperCase();
  if (["USD", "EUR", "GBP", "CNY", "JPY"].includes(normalizedUnit)) {
    const formatter = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: normalizedUnit,
      maximumFractionDigits: normalizedUnit === "JPY" ? 0 : 2,
    });
    return (amount) => formatter.format(amount);
  }
  const formatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  return (amount) => `${formatter.format(amount)} ${unit}`;
}

function formatProviderReset(resetAt: number | undefined): string | null {
  if (!resetAt || !Number.isFinite(resetAt)) {
    return null;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(resetAt));
}

function renderProviderBilling(snapshot: ProviderUsageDetails) {
  return (
    <For each={snapshot.billing ?? []}>
      {(entry) => {
        const label = () => entry.label ?? t(`usage.providerUsage.${entry.type}`);
        const formatAmount = createProviderAmountFormatter(entry.unit);
        const value =
          entry.type === "budget"
            ? `${formatAmount(entry.used)} / ${formatAmount(entry.limit)}`
            : formatAmount(entry.amount);
        return (
          <div class="provider-usage-billing-row">
            <span>{label()}</span>
            <strong>{value}</strong>
          </div>
        );
      }}
    </For>
  );
}

function providerHistoryAmount(
  history: NonNullable<ProviderUsageDetails["costHistory"]>,
  days: number,
): number {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const cutoff = today - (Math.max(1, days) - 1) * 86_400_000;
  return history.daily.reduce((total, day) => {
    const time = Date.parse(`${day.date}T00:00:00Z`);
    return Number.isFinite(time) && time >= cutoff && time <= today ? total + day.amount : total;
  }, 0);
}

function renderCostBreakdown<T extends { name: string }>(
  title: string,
  entries: T[],
  formatValue: (entry: T) => string,
) {
  return entries.length > 0 ? (
    <div class="provider-cost-breakdown">
      <span class="provider-cost-breakdown__title">{title}</span>
      <For each={entries.slice(0, 3)}>
        {(entry) => (
          <div>
            <span>{entry.name}</span>
            <strong>{formatValue(entry)}</strong>
          </div>
        )}
      </For>
    </div>
  ) : undefined;
}

function renderProviderCostHistory(snapshot: ProviderUsageDetails) {
  const history = snapshot.costHistory;
  if (!history || history.daily.length === 0) {
    return undefined;
  }
  let maxAmount = 0;
  let periodAmount = 0;
  const totals = { requests: 0, input: 0, cache: 0, output: 0 };
  for (const day of history.daily) {
    maxAmount = Math.max(maxAmount, day.amount);
    periodAmount += day.amount;
    totals.requests += day.requests ?? 0;
    totals.input += day.inputTokens;
    totals.cache = totals.cache + day.cacheReadTokens + day.cacheWriteTokens;
    totals.output += day.outputTokens;
  }
  const windows = [
    [t("usage.providerUsage.today"), providerHistoryAmount(history, 1)],
    [t("usage.providerUsage.last7Days"), providerHistoryAmount(history, 7)],
    [t("usage.providerUsage.lastDays", { count: String(history.periodDays) }), periodAmount],
  ] as const;
  const formatAmount = createProviderAmountFormatter(history.unit);
  return (
    <div class="provider-cost-history">
      <div class="provider-cost-windows">
        <For each={windows}>
          {([label, amount]) => (
            <div class="provider-cost-window">
              <span>{label}</span>
              <strong>{formatAmount(amount)}</strong>
            </div>
          )}
        </For>
      </div>
      <div class="provider-cost-chart" role="group" aria-label={t("usage.providerUsage.dailyCost")}>
        <For each={history.daily}>
          {(day) => {
            const height =
              day.amount > 0 && maxAmount > 0 ? Math.max(3, (day.amount / maxAmount) * 100) : 0;
            const label = `${day.date}: ${formatAmount(day.amount)}`;
            return (
              <span role="img" style={{ height: `${height}%` }} title={label} aria-label={label} />
            );
          }}
        </For>
      </div>
      <div class="provider-cost-tokens">
        {totals.requests > 0 ? (
          <span>
            {t("usage.providerUsage.requests", {
              count: new Intl.NumberFormat().format(totals.requests),
            })}
          </span>
        ) : undefined}
        <span>
          {t("usage.providerUsage.inputTokens", { count: formatCompactTokenCount(totals.input) })}
        </span>
        <span>
          {t("usage.providerUsage.cacheTokens", { count: formatCompactTokenCount(totals.cache) })}
        </span>
        <span>
          {t("usage.providerUsage.outputTokens", { count: formatCompactTokenCount(totals.output) })}
        </span>
      </div>
      {history.models.length > 0 || history.categories.length > 0 ? (
        <div class="provider-cost-breakdowns">
          {renderCostBreakdown(t("usage.providerUsage.topModels"), history.models, (model) =>
            formatCompactTokenCount(model.totalTokens),
          )}
          {renderCostBreakdown(
            t("usage.providerUsage.costCategories"),
            history.categories,
            (category) => formatAmount(category.amount),
          )}
        </div>
      ) : undefined}
    </div>
  );
}

function renderProviderUsageWindow(window: UsageWindow) {
  const used = Math.max(0, Math.min(100, window.usedPercent));
  const remaining = Math.max(0, 100 - used);
  const remainingTone = remaining <= 10 ? "danger" : remaining <= 25 ? "warn" : "ok";
  const remainingLabel = () =>
    t("usage.providerUsage.remaining", { percent: remaining.toFixed(0) });
  const reset = formatProviderReset(window.resetAt);
  return (
    <div class="provider-usage-window">
      <div class="provider-usage-window__meta">
        <span>{window.label}</span>
        <strong>{remainingLabel()}</strong>
      </div>
      <div
        class={`provider-usage-progress provider-usage-progress--${remainingTone}`}
        role="progressbar"
        aria-label={window.label}
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={remaining.toFixed(0)}
        aria-valuetext={remainingLabel()}
      >
        <span style={{ width: `${remaining}%` }} />
      </div>
      {reset ? (
        <div class="provider-usage-reset">{t("usage.providerUsage.resets", { date: reset })}</div>
      ) : undefined}
    </div>
  );
}

/** The surrounding card header (name, plan badge, icon) stays surface-owned. */
export function renderProviderUsageDetails(
  snapshot: ProviderUsageDetails,
  options: ProviderUsageDetailsOptions = {},
) {
  if (snapshot.error) {
    return <div class="provider-usage-error">{formatUiExternalText(snapshot.error)}</div>;
  }
  return (
    <>
      {snapshot.windows.length > 0 ? (
        options.groupWindows ? (
          <div class="provider-usage-windows provider-usage-windows--grouped">
            <For each={[...groupUsageWindows(snapshot.windows)]}>
              {([label, windows]) => (
                <div
                  class="provider-usage-window-group"
                  role="group"
                  aria-label={label || undefined}
                >
                  {label ? (
                    <div class="provider-usage-window-group__title">{label}</div>
                  ) : undefined}
                  <div class="provider-usage-window-group__windows">
                    <For each={windows}>{renderProviderUsageWindow}</For>
                  </div>
                </div>
              )}
            </For>
          </div>
        ) : (
          <div class="provider-usage-windows">
            <For each={snapshot.windows}>{renderProviderUsageWindow}</For>
          </div>
        )
      ) : undefined}
      {snapshot.billing && snapshot.billing.length > 0 ? (
        <div class="provider-usage-billing">{renderProviderBilling(snapshot)}</div>
      ) : undefined}
      {renderProviderCostHistory(snapshot)}
      {snapshot.summary ? <div class="provider-usage-summary">{snapshot.summary}</div> : undefined}
    </>
  );
}
