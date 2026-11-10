import { For, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import type { ProviderQuotaGroup } from "../../../lib/provider-quota-summary.ts";
import { t } from "../../../lib/reactive/i18n.ts";

// Provider window labels arrive as compact data strings ("5h", "Week"); model
// scoped labels (e.g. "Opus") pass through untranslated.
function formatUsageWindowLabel(label: string): string {
  if (label === "5h") {
    return t("chat.composer.contextUsage.limitFiveHour");
  }
  if (label === "Week") {
    return t("chat.composer.contextUsage.limitWeekly");
  }
  if (label === "Day") {
    return t("chat.composer.contextUsage.limitDaily");
  }
  const hours = /^(\d+)h$/.exec(label);
  if (hours) {
    return t("chat.composer.contextUsage.limitHours", { hours: hours[1] ?? "" });
  }
  return label;
}

function formatBudgetAmount(amount: number, unit: string): string {
  if (/^[A-Za-z]{3}$/.test(unit)) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: unit.toUpperCase(),
        maximumFractionDigits: 2,
      }).format(amount);
    } catch {
      // Non-ISO currency codes fall through to plain unit suffix formatting.
    }
  }
  return `${amount.toFixed(2)} ${unit}`;
}

function quotaReset(resetAt?: number): string {
  if (resetAt === undefined) {
    return t("usage.common.emptyValue");
  }
  const date = new Date(resetAt);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { weekday: "short" });
}

function QuotaRow(props: {
  label: string;
  usedPercent: number;
  value: string;
  index: number;
  reset?: string;
}) {
  return (
    <div
      class="context-usage__limit"
      role="progressbar"
      aria-label={props.label}
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={props.usedPercent}
      aria-valuetext={props.value}
      style={{ "--quota-strength": Math.min(props.index, 2) * 0.75 + 2 }}
    >
      <span class="context-usage__limit-fill" style={{ width: `${props.usedPercent}%` }} />
      <span class="context-usage__limit-tick" aria-hidden="true" />
      <div class="context-usage__limit-content">
        <span class="context-usage__limit-label">{props.label}</span>
        <Show when={props.reset}>
          <span
            class="context-usage__limit-reset"
            title={t("chat.composer.contextUsage.resets", { time: props.reset! })}
          >
            <Icon name="refresh" />
            {props.reset}
          </span>
        </Show>
        <strong
          class={[
            "context-usage__limit-value",
            {
              "context-usage__limit-value--warn": props.usedPercent >= 75 && props.usedPercent < 90,
              "context-usage__limit-value--danger": props.usedPercent >= 90,
            },
          ]}
        >
          {props.value}
        </strong>
      </div>
    </div>
  );
}

export default function QuotaMetrics(props: { group: ProviderQuotaGroup }) {
  return (
    <>
      <For each={props.group.windows} keyed={false}>
        {(limit, index) => {
          const usedPercent = () => Math.max(0, Math.min(100, Math.round(limit().usedPercent)));
          return (
            <QuotaRow
              label={formatUsageWindowLabel((limit().label || "").trim())}
              usedPercent={usedPercent()}
              value={`${usedPercent()}%`}
              reset={quotaReset(limit().resetAt)}
              index={index}
            />
          );
        }}
      </For>
      <For each={props.group.budgets} keyed={false}>
        {(budget, index) => (
          <QuotaRow
            label={budget().label || t("chat.composer.contextUsage.usageCredits")}
            usedPercent={Math.max(
              0,
              Math.min(100, Math.round((budget().used / budget().limit) * 100)),
            )}
            value={t("chat.composer.contextUsage.budgetValue", {
              used: formatBudgetAmount(budget().used, budget().unit),
              limit: formatBudgetAmount(budget().limit, budget().unit),
            })}
            index={props.group.windows.length + index}
          />
        )}
      </For>
    </>
  );
}
