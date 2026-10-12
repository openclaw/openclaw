import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asNullableObjectRecord as readCostRecord } from "@openclaw/normalization-core/record-coerce";
import { For, Show, createMemo } from "solid-js";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../../../../../src/shared/transcript-only-openclaw-assistant.js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { normalizeBasePath } from "../../../app-route-paths.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../i18n/index.ts";
import { formatCompactTokenCount, formatCost } from "../../../lib/format.ts";
import { isMonitoredAuthProvider } from "../../../lib/model-auth.ts";
import {
  collectProviderQuotaGroups,
  formatQuotaReset,
  type ProviderQuotaGroup,
  type ProviderUsageDisplayProps,
} from "../../../lib/provider-quota-summary.ts";
import { resolveSessionContextLimit } from "../../../lib/sessions/context-budget.ts";
import { handleChatComposerDetailsToggle, syncChatPickerOverlay } from "./chat-picker-overlay.ts";

const CONTEXT_NOTICE_RATIO = 0.85;

type ContextNoticeOptions = {
  messages?: unknown[];
  providerUsage?: ProviderUsageDisplayProps;
};

type ProviderCostStats = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

function latestProviderCostStats(messages: unknown[] | undefined): ProviderCostStats | null {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = readCostRecord(messages?.[index]);
    if (message?.role === "user") {
      return null;
    }
    if (message?.role !== "assistant" || isTranscriptOnlyOpenClawAssistantMessage(message)) {
      continue;
    }
    const directCost = readCostRecord(message.cost);
    const usageCost = readCostRecord(readCostRecord(message.usage)?.cost);
    const stats: ProviderCostStats = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      const cost =
        asNonNegativeFiniteNumber(directCost?.[key]) ?? asNonNegativeFiniteNumber(usageCost?.[key]);
      if (cost !== undefined) {
        stats[key] = cost;
      }
    }
    if (Object.keys(stats).length > 0) {
      return stats;
    }
  }
  return null;
}

function latestAssistantProvider(messages: unknown[] | undefined): string | null {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = readCostRecord(messages?.[index]);
    if (message?.role !== "assistant" || isTranscriptOnlyOpenClawAssistantMessage(message)) {
      continue;
    }
    return typeof message.provider === "string" ? message.provider.trim() || null : null;
  }
  return null;
}

function getContextNoticeViewModel(session: GatewaySessionRow | undefined) {
  const used = asNonNegativeFiniteNumber(session?.totalTokens);
  const { tokens: limit, fromLastPrompt } = resolveSessionContextLimit(session);
  if (used === undefined || !limit) {
    return null;
  }
  const approximate = session?.totalTokensFresh === false;
  const ratio = used / limit;
  const pct = Math.min(Math.round(ratio * 100), 100);
  // A stale total is still useful orientation, but must not drive warning or
  // compaction decisions because the session may already have compacted.
  const warning = !approximate && ratio >= CONTEXT_NOTICE_RATIO;
  // Session rows expose the latest run snapshot; totalTokens is the separate context snapshot.
  const input = Number.isFinite(session?.inputTokens) ? (session?.inputTokens ?? null) : null;
  const output = Number.isFinite(session?.outputTokens) ? (session?.outputTokens ?? null) : null;
  const cost = asNonNegativeFiniteNumber(session?.estimatedCostUsd) ?? null;
  let color = "var(--muted)";
  let bg = "color-mix(in srgb, var(--muted) 8%, transparent)";
  if (warning) {
    const mix = Math.min(Math.max((ratio - CONTEXT_NOTICE_RATIO) / 0.1, 0), 1);
    color = `color-mix(in srgb, var(--warn), var(--danger) ${mix * 100}%)`;
    bg = `color-mix(in srgb, ${color} ${8 + 8 * mix}%, transparent)`;
  }
  return {
    pct,
    fromLastPrompt,
    used,
    limit,
    input,
    output,
    cost,
    detail: `${approximate ? "~" : ""}${formatCompactTokenCount(used)} / ${formatCompactTokenCount(limit)}`,
    color,
    bg,
    warning,
    approximate,
  };
}

const RING_RADIUS = 6.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

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

function QuotaRow(props: {
  label: string;
  usedPercent: number;
  value: string;
  reset?: string | null;
}) {
  const severity = () =>
    props.usedPercent >= 90 ? "danger" : props.usedPercent >= 75 ? "warn" : null;
  return (
    <div class="context-usage__limit">
      <div class="context-usage__limit-head">
        <span class="context-usage__limit-label">{props.label}</span>{" "}
        <span class="context-usage__limit-meta">
          {props.reset ? (
            <>
              <span class="context-usage__limit-reset">
                {t("chat.composer.contextUsage.resets", { time: props.reset })}
              </span>{" "}
            </>
          ) : null}
          <strong>{props.value}</strong>
        </span>
      </div>
      <div
        class="context-usage__limit-bar"
        role="progressbar"
        aria-label={props.label}
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={props.usedPercent}
      >
        <span
          class={severity() ? `context-usage__limit-fill--${severity()}` : ""}
          style={{ width: `${props.usedPercent}%` }}
        />
      </div>
    </div>
  );
}

function QuotaGroup(props: { group: ProviderQuotaGroup; usageHref: string }) {
  return (
    <>
      <div class="context-usage__section-label context-usage__plan-header">
        <span>{t("chat.composer.contextUsage.planUsage")}</span>
        <a
          class="context-usage__plan-link"
          href={props.usageHref}
          data-chat-provider-usage="true"
          aria-label={t("chat.composer.contextUsage.openUsage")}
        >
          {props.group.plan ? (
            <span class="context-usage__plan-badge">{props.group.plan}</span>
          ) : null}
          <Icon name="externalLink" />
        </a>
      </div>
      {props.group.accountEmail ? (
        <div class="context-usage__account" data-chat-usage-account="true">
          {props.group.accountEmail}
        </div>
      ) : null}
      <div class="context-usage__limits">
        <For each={props.group.windows} keyed={false}>
          {(limit) => (
            <QuotaRow
              label={formatUsageWindowLabel(limit().label)}
              usedPercent={limit().usedPercent}
              value={`${limit().usedPercent}%`}
              reset={formatQuotaReset(limit().resetAt)}
            />
          )}
        </For>
        <For each={props.group.budgets} keyed={false}>
          {(budget) => (
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
            />
          )}
        </For>
      </div>
      <div class="context-usage__provenance" data-chat-usage-provider="true">
        <span>{t("sessionsView.provider")}:</span> <strong>{props.group.displayName}</strong>
      </div>
    </>
  );
}

function renderContextStat(label: string, value: string) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

type ContextNoticeProps = ContextNoticeOptions & {
  session?: GatewaySessionRow;
};

export function ContextNotice(props: ContextNoticeProps) {
  const model = createMemo(() => getContextNoticeViewModel(props.session));
  const currentGroup = createMemo(() => {
    const provider = (
      props.session?.modelProvider?.trim() || latestAssistantProvider(props.messages)
    )?.toLowerCase();
    if (!provider || !props.providerUsage) {
      return undefined;
    }
    return collectProviderQuotaGroups(
      props.providerUsage.modelAuthStatusResult ?? null,
      isMonitoredAuthProvider,
    ).find((group) => group.providers.some((id) => id.trim().toLowerCase() === provider));
  });
  const summary = createMemo(() => {
    const context = model();
    return context
      ? t("chat.composer.contextUsage.summary", {
          used: `${context.approximate ? "~" : ""}${formatCompactTokenCount(context.used)}`,
          limit: formatCompactTokenCount(context.limit),
          pct: `${context.approximate ? "~" : ""}${context.pct}`,
        })
      : t("chat.usageRemaining");
  });
  const colors = createMemo(() => {
    const context = model();
    return context ? { "--ctx-color": context.color, "--ctx-bg": context.bg } : undefined;
  });
  const dashOffset = () => RING_CIRCUMFERENCE * (1 - (model()?.pct ?? 0) / 100);
  const providerCosts = createMemo(() =>
    model() ? latestProviderCostStats(props.messages) : null,
  );
  // Plan-billed sessions hide dollar estimates: subscription usage is bounded
  // by the plan windows below, and per-token math would misread as real spend.
  // Billing mode is provider-level: session rows do not record which auth
  // profile served the run, so a provider with both an API key and a
  // subscription resolves to subscription display (per-run credential
  // attribution is #102807).
  const showCosts = () => !currentGroup();
  const usageHref = () => `${normalizeBasePath(props.providerUsage?.basePath ?? "")}/usage`;
  const formatStat = (value: number | null) =>
    value === null ? t("usage.common.emptyValue") : formatCompactTokenCount(value);
  const renderCostStat = (label: string, value: number | undefined) =>
    value === undefined || value <= 0 ? null : renderContextStat(label, formatCost(value));
  const renderEstimate = (value: number | null) =>
    value === null
      ? null
      : renderContextStat(t("chat.composer.contextUsage.estimatedCost"), formatCost(value));
  const hasProviderCosts = () => {
    const costs = providerCosts();
    return showCosts() && costs && Object.values(costs).some((value) => value > 0);
  };
  return (
    <Show when={Boolean(model() || currentGroup())}>
      <div class="context-usage" style={colors()}>
        <details
          onToggle={(event: Event) => {
            handleChatComposerDetailsToggle(event);
            if (event.currentTarget instanceof HTMLDetailsElement) {
              syncChatPickerOverlay(event.currentTarget);
            }
          }}
        >
          <summary
            class={["context-ring", { "context-ring--warning": model()?.warning }]}
            aria-label={summary()}
            title={t("chat.composer.contextUsage.open")}
          >
            <svg
              class="context-ring__dial"
              viewBox="0 0 16 16"
              width="16"
              height="16"
              aria-hidden="true"
            >
              <circle class="context-ring__track" cx="8" cy="8" r={RING_RADIUS} />
              <circle
                class="context-ring__fill"
                cx="8"
                cy="8"
                r={RING_RADIUS}
                stroke-dasharray={RING_CIRCUMFERENCE.toFixed(2)}
                stroke-dashoffset={dashOffset().toFixed(2)}
              />
            </svg>
          </summary>
          <wa-popup data-anchored-overlay>
            <section
              class="context-usage__popover"
              aria-label={t("chat.composer.contextUsage.title")}
            >
              <Show when={model()}>
                {(context) => (
                  <>
                    <div class="context-usage__header">
                      <span class="context-usage__title">
                        {t(
                          context().fromLastPrompt
                            ? "chat.composer.contextUsage.promptBudget"
                            : "chat.composer.contextUsage.contextWindow",
                        )}
                      </span>
                      <strong class="context-usage__context-value">
                        {context().detail} · {context().approximate ? "~" : ""}
                        {context().pct}%
                      </strong>
                    </div>
                    <div
                      class="context-usage__bar"
                      role="progressbar"
                      aria-label={summary()}
                      aria-valuemin="0"
                      aria-valuemax="100"
                      aria-valuenow={context().pct}
                    >
                      <span style={{ width: `${context().pct}%` }} />
                    </div>
                    <div class="context-usage__section-label">
                      {t("chat.composer.contextUsage.latestRunTokens")}
                    </div>
                    <dl class="context-usage__stats">
                      {renderContextStat(t("usage.breakdown.input"), formatStat(context().input))}
                      {renderContextStat(t("usage.breakdown.output"), formatStat(context().output))}
                      {showCosts() ? renderEstimate(context().cost) : null}
                    </dl>
                  </>
                )}
              </Show>
              <Show when={hasProviderCosts() ? providerCosts() : null}>
                {(costs) => (
                  <>
                    <div class="context-usage__section-label">
                      {t("usage.breakdown.costByType")}
                    </div>
                    <dl class="context-usage__stats">
                      {renderCostStat(t("usage.breakdown.input"), costs().input)}
                      {renderCostStat(t("usage.breakdown.output"), costs().output)}
                      {renderCostStat(t("usage.breakdown.cacheRead"), costs().cacheRead)}
                      {renderCostStat(t("usage.breakdown.cacheWrite"), costs().cacheWrite)}
                    </dl>
                  </>
                )}
              </Show>
              <Show when={currentGroup()}>
                {(group) => <QuotaGroup group={group()} usageHref={usageHref()} />}
              </Show>
            </section>
          </wa-popup>
        </details>
      </div>
    </Show>
  );
}
