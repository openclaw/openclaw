import type { JSX } from "@solidjs/web";
/// <reference lib="es2024.collection" />
import { createMemo, For, Repeat, Show } from "solid-js";
import type {
  ProviderUsageSnapshot,
  UsageWindow,
} from "../../../../src/infra/provider-usage.types.js";
// Shared provider usage content: plan windows, balances and provider-billed cost.
// Surrounding headers (name, plan, icon) stay surface-owned.
import { registerProviderUsageEnglish } from "../../i18n/locales/en-provider-usage.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { formatCompactTokenCount } from "../../lib/format.ts";
import {
  formatDateTimeMs,
  formatNumber,
  formatRelativeTimestamp,
} from "../../lib/reactive/format.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import "../../styles/carapace-control-ui.css";
import "../../styles/provider-usage.css";

registerEnglishCatalog(registerProviderUsageEnglish);

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
    return (amount) =>
      formatNumber(amount, {
        style: "currency",
        currency: normalizedUnit,
        maximumFractionDigits: normalizedUnit === "JPY" ? 0 : 2,
      });
  }
  return (amount) => `${formatNumber(amount, { maximumFractionDigits: 2 })} ${unit}`;
}

/** A reset as a calendar date plus "in 3 hours", or nothing when it is unknown or past. */
function resetText(window: UsageWindow): { date?: string; relative?: string } {
  if (!window.resetAt || !Number.isFinite(window.resetAt) || window.resetAt <= Date.now()) {
    return {};
  }
  return {
    date: formatDateTimeMs(window.resetAt, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
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

/** The plan limit worth a glance: the tightest window running out, or a failed check. */
export function providerUsageAttention(
  usage: ProviderUsageDetails | undefined,
): { kind: "warn" | "danger"; label: string } | undefined {
  const tightest = usage?.windows
    .filter((window) => remainingTone(window) !== undefined)
    .toSorted((left, right) => remainingPercent(left) - remainingPercent(right))[0];
  if (tightest) {
    return {
      kind: remainingTone(tightest) === "error" ? "danger" : "warn",
      label: `${tightest.label} ${t("usage.providerUsage.remaining", {
        percent: String(remainingPercent(tightest)),
      })}`,
    };
  }
  return usage?.error ? { kind: "warn", label: t("usage.providerUsage.checkFailed") } : undefined;
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

/** One usage fact at every width: what it is, its mark and value, then when it matters. */
function UsageFact(props: {
  class?: string;
  label: string;
  value: string;
  mark?: JSX.Element;
  detail?: string;
  tone?: "warning" | "error";
}) {
  return (
    <div class={["provider-usage__fact", props.class]} data-tone={props.tone}>
      <span class="provider-usage__window-label">{props.label}</span>
      <span class="provider-usage__reading">
        {props.mark}
        <strong class="provider-usage__window-value">{props.value}</strong>
      </span>
      <Show when={props.detail}>
        <small class="provider-usage__reset">{props.detail}</small>
      </Show>
    </div>
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

/** The period total with its trend; the Usage page has the full breakdown. */
function CostFact(props: { history: CostHistory }) {
  const format = createMemo(() => createProviderAmountFormatter(props.history.unit));
  const periods = () => [
    ...(props.history.periodDays > 1
      ? [`${t("usage.providerUsage.today")} ${format()(historyAmount(props.history, 1))}`]
      : []),
    ...(props.history.periodDays > 7
      ? [`${t("usage.providerUsage.last7Days")} ${format()(historyAmount(props.history, 7))}`]
      : []),
  ];
  return (
    <UsageFact
      label={t("usage.providerUsage.lastDays", { count: String(props.history.periodDays) })}
      value={format()(props.history.daily.reduce((sum, day) => sum + day.amount, 0))}
      detail={periods().join(" · ")}
      mark={
        <StepSparkline
          values={props.history.daily.map((day) => day.amount)}
          color="var(--oc-accent-secondary)"
          label={t("usage.providerUsage.dailyCost")}
        />
      }
    />
  );
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
      <Repeat count={3}>
        {(index) => (
          <div class="oc-menu-panel-usage-row provider-usage__row">
            <span class="oc-menu-panel-usage-label">{windows()[index]![0]}</span>
            <span />
            <span class="oc-menu-panel-usage-value">{format()(windows()[index]![1])}</span>
          </div>
        )}
      </Repeat>
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
          color="var(--oc-accent-secondary)"
          label={t("usage.providerUsage.dailyCost")}
        />
        <small>
          {[
            totals().requests > 0
              ? t("usage.providerUsage.requests", {
                  count: formatNumber(totals().requests),
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

/**
 * Every plan window with its reset, then balances, billed cost and notes.
 * `compact` keeps billed cost to its total and trend where the Usage page is one click away.
 */
export function ProviderUsagePanel(props: { usage: ProviderUsageDetails; compact?: boolean }) {
  const groups = createMemo(() => [...groupUsageWindows(props.usage.windows)]);
  const history = () =>
    props.usage.costHistory?.daily.length ? props.usage.costHistory : undefined;
  const hasRows = () => (props.usage.billing?.length ?? 0) > 0 || Boolean(history());
  return (
    <div class="provider-usage">
      <Show when={props.usage.error}>
        {(error) => <p class="provider-usage__error">{formatUiExternalText(error())}</p>}
      </Show>
      <For each={groups()} keyed={([group]) => group}>
        {(group) => (
          <div class="provider-usage__group" role="group" aria-label={group()[0] || undefined}>
            <Show when={group()[0]}>
              <div class="provider-usage__note">{group()[0]}</div>
            </Show>
            {/* Provider snapshots have no row IDs and may repeat labels. These slots own no state. */}
            <For each={group()[1]} keyed={false}>
              {(window) => (
                <UsageFact
                  class="provider-usage__window"
                  label={window().label}
                  value={t("usage.providerUsage.remaining", {
                    percent: String(remainingPercent(window())),
                  })}
                  tone={remainingTone(window())}
                  mark={<UsageWindowMeter window={window()} />}
                  detail={
                    resetText(window()).date
                      ? t("usage.providerUsage.resets", {
                          date: `${resetText(window()).date} · ${resetText(window()).relative}`,
                        })
                      : undefined
                  }
                />
              )}
            </For>
          </div>
        )}
      </For>
      <Show
        when={props.compact}
        fallback={
          <Show when={hasRows()}>
            <div class="oc-menu-panel-usage provider-usage__rows">
              <For each={props.usage.billing ?? []} keyed={false}>
                {(entry) => (
                  <div class="oc-menu-panel-usage-row provider-usage__row">
                    <span class="oc-menu-panel-usage-label">{billingLabel(entry())}</span>
                    <span />
                    <span class="oc-menu-panel-usage-value">{billingText(entry())}</span>
                  </div>
                )}
              </For>
              <Show when={history()}>{(cost) => <BilledCost history={cost()} />}</Show>
            </div>
          </Show>
        }
      >
        <For each={props.usage.billing ?? []} keyed={false}>
          {(entry) => <UsageFact label={billingLabel(entry())} value={billingText(entry())} />}
        </For>
        <Show when={history()}>{(cost) => <CostFact history={cost()} />}</Show>
      </Show>
      <Show when={props.usage.summary}>
        {(summary) => <p class="provider-usage__note">{summary()}</p>}
      </Show>
    </div>
  );
}
