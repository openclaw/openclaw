// Shared provider usage content: plan windows, balances and provider-billed cost.
// Surrounding headers (name, plan, icon) stay surface-owned.
import { createMemo, For, Show } from "solid-js";
import type {
  ProviderUsageSnapshot,
  UsageWindow,
} from "../../../../src/infra/provider-usage.types.js";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { formatCompactTokenCount } from "../../lib/format.ts";
import { formatRelativeTimestamp } from "../../lib/reactive/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import "../../styles/provider-usage.css";
import { Icon } from "./icon.tsx";

export type ProviderUsageDetails = Pick<
  ProviderUsageSnapshot,
  "windows" | "billing" | "costHistory" | "summary" | "error"
>;

type BillingEntry = NonNullable<ProviderUsageDetails["billing"]>[number];
type CostHistory = NonNullable<ProviderUsageDetails["costHistory"]>;

const SPARK_WIDTH = 120;
const SPARK_HEIGHT = 28;

function steppedPath(input: number[], width: number, height: number): string {
  // Provider-reported amounts can be negative or non-finite; they draw as zero.
  const values = input.map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
  const max = Math.max(...values, 0);
  if (values.length === 0 || max <= 0) {
    return `M0 ${height - 1} H${width}`;
  }
  const step = width / values.length;
  const y = (value: number) => (height - 2 - (value / max) * (height - 4) + 1).toFixed(1);
  return values
    .map(
      (value, index) =>
        `${index === 0 ? `M0 ${y(value)}` : `V${y(value)}`} H${((index + 1) * step).toFixed(1)}`,
    )
    .join(" ");
}

/** A daily trend beside its totals; the tone is the series color. */
function StepSparkline(props: { values: number[]; color: string; label: string }) {
  const path = createMemo(() => steppedPath(props.values, SPARK_WIDTH, SPARK_HEIGHT));
  return (
    <svg
      class="oc-sparkline"
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={props.label}
    >
      <path class="oc-sparkline-line" style={{ stroke: props.color }} d={path()} />
    </svg>
  );
}

function windowRank(label: string): number {
  if (/\b\d+(?:m|h)\b/iu.test(label) && !/\b168h\b/iu.test(label)) {
    return 0;
  }
  return /\b(?:week|168h)\b/iu.test(label) ? 1 : 2;
}

function groupUsageWindows(windows: UsageWindow[]): Map<string, UsageWindow[]> {
  const groups = Map.groupBy(windows, (window) => window.groupLabel ?? "");
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

/** A reset as a calendar date plus "in 3 hours", or nothing when it is unknown or past. */
function resetText(window: UsageWindow): { date?: string; relative?: string } {
  if (!window.resetAt || !Number.isFinite(window.resetAt) || window.resetAt <= Date.now()) {
    return {};
  }
  return {
    date: new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(window.resetAt)),
    relative: formatRelativeTimestamp(window.resetAt),
  };
}

function remainingPercent(window: UsageWindow): number {
  return Math.round(100 - Math.max(0, Math.min(100, window.usedPercent)));
}

/** Little headroom reads as a warning, none as an error. */
function remainingTone(window: UsageWindow): "warning" | "error" | undefined {
  const remaining = remainingPercent(window);
  return remaining <= 10 ? "error" : remaining <= 25 ? "warning" : undefined;
}

const billingLabel = (entry: BillingEntry) => entry.label ?? t(`usage.providerUsage.${entry.type}`);

function billingText(entry: BillingEntry): string {
  const format = createProviderAmountFormatter(entry.unit);
  return entry.type === "budget"
    ? `${format(entry.used)} / ${format(entry.limit)}`
    : format(entry.amount);
}

export function hasProviderUsageDetails(usage: ProviderUsageDetails | undefined): boolean {
  return Boolean(
    usage &&
    (usage.windows.length > 0 ||
      (usage.billing?.length ?? 0) > 0 ||
      (usage.costHistory?.daily.length ?? 0) > 0 ||
      usage.error ||
      usage.summary),
  );
}

/** Remaining headroom of one plan window; the fill shows what is left. */
function UsageWindowMeter(props: { window: UsageWindow }) {
  return (
    <div
      class="oc-inspector-meter"
      role="meter"
      aria-label={props.window.label}
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={String(remainingPercent(props.window))}
      aria-valuetext={t("usage.providerUsage.remaining", {
        percent: String(remainingPercent(props.window)),
      })}
    >
      <span style={{ width: `${remainingPercent(props.window)}%` }} />
    </div>
  );
}

function historyAmount(history: CostHistory, days: number): number {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const cutoff = today - (Math.max(1, days) - 1) * 86_400_000;
  return history.daily.reduce((total, day) => {
    const time = Date.parse(`${day.date}T00:00:00Z`);
    return Number.isFinite(time) && time >= cutoff && time <= today ? total + day.amount : total;
  }, 0);
}

function BilledCost(props: { history: CostHistory }) {
  const format = createMemo(() => createProviderAmountFormatter(props.history.unit));
  const totals = createMemo(() =>
    props.history.daily.reduce(
      (sum, day) => ({
        requests: sum.requests + (day.requests ?? 0),
        input: sum.input + day.inputTokens,
        cache: sum.cache + day.cacheReadTokens + day.cacheWriteTokens,
        output: sum.output + day.outputTokens,
      }),
      { requests: 0, input: 0, cache: 0, output: 0 },
    ),
  );
  const windows = createMemo(
    () =>
      [
        [t("usage.providerUsage.today"), historyAmount(props.history, 1)],
        [t("usage.providerUsage.last7Days"), historyAmount(props.history, 7)],
        [
          t("usage.providerUsage.lastDays", { count: String(props.history.periodDays) }),
          props.history.daily.reduce((sum, day) => sum + day.amount, 0),
        ],
      ] as const,
  );
  return (
    <>
      <For each={windows()}>
        {([label, amount]) => (
          <div class="oc-menu-panel-usage-row provider-usage__row">
            <span class="oc-menu-panel-usage-label">{label}</span>
            <span />
            <span class="oc-menu-panel-usage-value">{format()(amount)}</span>
          </div>
        )}
      </For>
      <Show when={props.history.models.length > 0}>
        <div class="oc-menu-panel-usage-row provider-usage__row">
          <span class="oc-menu-panel-usage-label">{t("usage.providerUsage.topModels")}</span>
          <span />
          <span class="oc-menu-panel-usage-value">
            {props.history.models
              .slice(0, 3)
              .map((model) => `${model.name} ${formatCompactTokenCount(model.totalTokens)}`)
              .join(", ")}
          </span>
        </div>
      </Show>
      <Show when={props.history.categories.length > 0}>
        <div class="oc-menu-panel-usage-row provider-usage__row">
          <span class="oc-menu-panel-usage-label">{t("usage.providerUsage.costCategories")}</span>
          <span />
          <span class="oc-menu-panel-usage-value">
            {props.history.categories
              .slice(0, 3)
              .map((category) => `${category.name} ${format()(category.amount)}`)
              .join(", ")}
          </span>
        </div>
      </Show>
      <div class="provider-usage__trend">
        <StepSparkline
          values={props.history.daily.map((day) => day.amount)}
          color="var(--oc-accent)"
          label={t("usage.providerUsage.dailyCost")}
        />
        <small>
          {[
            totals().requests > 0
              ? t("usage.providerUsage.requests", {
                  count: new Intl.NumberFormat().format(totals().requests),
                })
              : null,
            t("usage.providerUsage.inputTokens", {
              count: formatCompactTokenCount(totals().input),
            }),
            t("usage.providerUsage.cacheTokens", {
              count: formatCompactTokenCount(totals().cache),
            }),
            t("usage.providerUsage.outputTokens", {
              count: formatCompactTokenCount(totals().output),
            }),
          ]
            .filter(Boolean)
            .join(" · ")}
        </small>
      </div>
    </>
  );
}

/** Every plan window with its reset, then balances, billed cost and notes. */
export function ProviderUsagePanel(props: { usage: ProviderUsageDetails }) {
  const groups = createMemo(() => [...groupUsageWindows(props.usage.windows)]);
  // A used-up window blocks requests until it resets; say which one and when.
  const exhausted = createMemo(() =>
    props.usage.windows.find((window) => remainingPercent(window) === 0),
  );
  const hasRows = () =>
    (props.usage.billing?.length ?? 0) > 0 || (props.usage.costHistory?.daily.length ?? 0) > 0;
  return (
    <div class="provider-usage">
      <Show when={props.usage.error}>
        {(error) => <p class="provider-usage__error">{formatUiExternalText(error())}</p>}
      </Show>
      <Show when={exhausted()}>
        {(window) => (
          <p class="provider-usage__alert" role="status">
            <Icon name="alertTriangle" />
            {resetText(window()).date
              ? t("usage.providerUsage.exhaustedUntil", {
                  label: window().label,
                  date: resetText(window()).date!,
                })
              : t("usage.providerUsage.exhausted", { label: window().label })}
          </p>
        )}
      </Show>
      <For each={groups()}>
        {([group, windows]) => (
          <div class="provider-usage__group" role="group" aria-label={group || undefined}>
            <Show when={group}>
              <div class="provider-usage__note">{group}</div>
            </Show>
            <div class="provider-usage__windows">
              <For each={windows}>
                {(window) => (
                  <div class="provider-usage__window" data-tone={remainingTone(window)}>
                    <span class="provider-usage__window-label">{window.label}</span>
                    <strong class="provider-usage__window-value">
                      {t("usage.providerUsage.remaining", {
                        percent: String(remainingPercent(window)),
                      })}
                    </strong>
                    <UsageWindowMeter window={window} />
                    <Show when={resetText(window).date}>
                      <small class="provider-usage__reset">
                        {t("usage.providerUsage.resets", {
                          date: `${resetText(window).date} · ${resetText(window).relative}`,
                        })}
                      </small>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </div>
        )}
      </For>
      <Show when={hasRows()}>
        <div class="oc-menu-panel-usage provider-usage__rows">
          <For each={props.usage.billing ?? []}>
            {(entry) => (
              <div class="oc-menu-panel-usage-row provider-usage__row">
                <span class="oc-menu-panel-usage-label">{billingLabel(entry)}</span>
                <span />
                <span class="oc-menu-panel-usage-value">{billingText(entry)}</span>
              </div>
            )}
          </For>
          <Show when={props.usage.costHistory?.daily.length ? props.usage.costHistory : undefined}>
            {(history) => <BilledCost history={history()} />}
          </Show>
        </div>
      </Show>
      <Show when={props.usage.summary}>
        {(summary) => <p class="provider-usage__note">{summary()}</p>}
      </Show>
    </div>
  );
}

/** At most two windows (or the first balance) beside a provider's name; the panel has the rest. */
export function ProviderUsageChips(props: { usage: ProviderUsageDetails | undefined }) {
  const windows = () => props.usage?.windows.slice(0, 2) ?? [];
  const balance = () => (windows().length === 0 ? props.usage?.billing?.[0] : undefined);
  return (
    <span class="provider-usage__chips">
      <For each={windows()}>
        {(window) => (
          <span class="provider-usage__chip" data-tone={remainingTone(window)}>
            <span class="provider-usage__chip-label">{window.label}</span>
            <UsageWindowMeter window={window} />
            <span class="provider-usage__chip-value">
              {t("usage.providerUsage.remaining", { percent: String(remainingPercent(window)) })}
            </span>
          </span>
        )}
      </For>
      <Show when={balance()}>
        {(entry) => (
          <span class="provider-usage__chip">
            <span class="provider-usage__chip-label">{billingLabel(entry())}</span>
            <span class="provider-usage__chip-value">{billingText(entry())}</span>
          </span>
        )}
      </Show>
      <Show when={props.usage?.error}>
        <span class="provider-usage__chip provider-usage__chip--failed">
          {t("usage.providerUsage.checkFailed")}
        </span>
      </Show>
    </span>
  );
}
