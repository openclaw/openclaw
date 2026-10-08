import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asNullableObjectRecord as readCostRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../../../../../src/shared/transcript-only-openclaw-assistant.js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { normalizeBasePath } from "../../../app-route-paths.ts";
import { icons } from "../../../components/icons.ts";
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

type ContextNoticeViewModel = {
  /** Both usage and limit are known, so a percentage can be shown. */
  complete: boolean;
  pct: number;
  fromLastPrompt: boolean;
  used: number | null;
  limit: number | null;
  input: number | null;
  output: number | null;
  cost: number | null;
  detail: string;
  color: string;
  bg: string;
  warning: boolean;
  approximate: boolean;
};

const MUTED_COLOR = "var(--muted)";
const MUTED_BG = "color-mix(in srgb, var(--muted) 8%, transparent)";
const UNKNOWN_VALUE = "—";

function getContextNoticeViewModel(
  session: GatewaySessionRow | undefined,
  defaultContextTokens: number | null,
): ContextNoticeViewModel {
  const used = asNonNegativeFiniteNumber(session?.totalTokens) ?? null;
  const { tokens, fromLastPrompt } = resolveSessionContextLimit(session, defaultContextTokens);
  const limit = tokens > 0 ? tokens : null;
  const approximate = session?.totalTokensFresh === false;
  // Session rows expose the latest run snapshot; totalTokens is the separate context snapshot.
  const input = Number.isFinite(session?.inputTokens) ? (session?.inputTokens ?? null) : null;
  const output = Number.isFinite(session?.outputTokens) ? (session?.outputTokens ?? null) : null;
  const cost = asNonNegativeFiniteNumber(session?.estimatedCostUsd) ?? null;
  const prefix = approximate && used !== null ? "~" : "";
  const detail = `${prefix}${used === null ? UNKNOWN_VALUE : formatCompactTokenCount(used)} / ${
    limit === null ? UNKNOWN_VALUE : formatCompactTokenCount(limit)
  }`;
  const base = { fromLastPrompt, used, limit, input, output, cost, detail, approximate };
  if (used === null || limit === null) {
    // Keep the meter visible with an empty ring until both numbers are known,
    // e.g. before the first reply or for models missing a catalog context window.
    return { ...base, complete: false, pct: 0, color: MUTED_COLOR, bg: MUTED_BG, warning: false };
  }
  const ratio = used / limit;
  const pct = Math.min(Math.round(ratio * 100), 100);
  // A stale total is still useful orientation, but must not drive warning or
  // compaction decisions because the session may already have compacted.
  const warning = !approximate && ratio >= CONTEXT_NOTICE_RATIO;
  let color = MUTED_COLOR;
  let bg = MUTED_BG;
  if (warning) {
    const mix = Math.min(Math.max((ratio - CONTEXT_NOTICE_RATIO) / 0.1, 0), 1);
    color = `color-mix(in srgb, var(--warn), var(--danger) ${mix * 100}%)`;
    bg = `color-mix(in srgb, ${color} ${8 + 8 * mix}%, transparent)`;
  }
  return { ...base, complete: true, pct, color, bg, warning };
}

function contextNoticeSummary(model: ContextNoticeViewModel, hasPlanUsage: boolean): string {
  if (model.complete && model.used !== null && model.limit !== null) {
    return t("chat.composer.contextUsage.summary", {
      used: `${model.approximate ? "~" : ""}${formatCompactTokenCount(model.used)}`,
      limit: formatCompactTokenCount(model.limit),
      pct: `${model.approximate ? "~" : ""}${model.pct}`,
    });
  }
  if (model.used !== null) {
    return t("chat.composer.contextUsage.summaryUsedOnly", {
      used: `${model.approximate ? "~" : ""}${formatCompactTokenCount(model.used)}`,
    });
  }
  if (hasPlanUsage) {
    return t("chat.usageRemaining");
  }
  if (model.limit !== null) {
    return t("chat.composer.contextUsage.summaryLimitOnly", {
      limit: formatCompactTokenCount(model.limit),
    });
  }
  return t("chat.composer.contextUsage.unavailable");
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

function renderQuotaRow(label: string, usedPercent: number, value: string, reset?: string | null) {
  const severity = usedPercent >= 90 ? "danger" : usedPercent >= 75 ? "warn" : null;
  return html`
    <div class="context-usage__limit">
      <div class="context-usage__limit-head">
        <span class="context-usage__limit-label">${label}</span>
        <span class="context-usage__limit-meta">
          ${
            reset
              ? html`<span class="context-usage__limit-reset"
                  >${t("chat.composer.contextUsage.resets", { time: reset })}</span
                >`
              : nothing
          }
          <strong>${value}</strong>
        </span>
      </div>
      <div
        class="context-usage__limit-bar"
        role="progressbar"
        aria-label=${label}
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow=${usedPercent}
      >
        <span
          class=${severity ? `context-usage__limit-fill--${severity}` : ""}
          style="width: ${usedPercent}%"
        ></span>
      </div>
    </div>
  `;
}

function renderQuotaGroup(group: ProviderQuotaGroup, usageHref: string) {
  return html`
    <div class="context-usage__section-label context-usage__plan-header">
      <span>${t("chat.composer.contextUsage.planUsage")}</span>
      <a
        class="context-usage__plan-link"
        href=${usageHref}
        data-chat-provider-usage="true"
        aria-label=${t("chat.composer.contextUsage.openUsage")}
      >
        ${group.plan ? html`<span class="context-usage__plan-badge">${group.plan}</span>` : nothing}
        ${icons.externalLink}
      </a>
    </div>
    ${
      group.accountEmail
        ? html`<div class="context-usage__account" data-chat-usage-account="true">
            ${group.accountEmail}
          </div>`
        : nothing
    }
    <div class="context-usage__limits">
      ${group.windows.map((limit) =>
        renderQuotaRow(
          formatUsageWindowLabel(limit.label),
          limit.usedPercent,
          `${limit.usedPercent}%`,
          formatQuotaReset(limit.resetAt),
        ),
      )}
      ${group.budgets.map((budget) =>
        renderQuotaRow(
          budget.label || t("chat.composer.contextUsage.usageCredits"),
          Math.max(0, Math.min(100, Math.round((budget.used / budget.limit) * 100))),
          t("chat.composer.contextUsage.budgetValue", {
            used: formatBudgetAmount(budget.used, budget.unit),
            limit: formatBudgetAmount(budget.limit, budget.unit),
          }),
        ),
      )}
    </div>
    <div class="context-usage__provenance" data-chat-usage-provider="true">
      <span>${t("sessionsView.provider")}:</span>
      <strong>${group.displayName}</strong>
    </div>
  `;
}

export function renderContextNotice(
  session: GatewaySessionRow | undefined,
  defaultContextTokens: number | null,
  options: ContextNoticeOptions = {},
) {
  const model = getContextNoticeViewModel(session, defaultContextTokens);
  const quotaGroups = options.providerUsage
    ? collectProviderQuotaGroups(
        options.providerUsage.modelAuthStatusResult ?? null,
        isMonitoredAuthProvider,
      )
    : [];
  const currentProvider =
    session?.modelProvider?.trim() || latestAssistantProvider(options.messages);
  const normalizedProvider = currentProvider?.toLowerCase();
  const currentGroup = normalizedProvider
    ? quotaGroups.find((group) =>
        group.providers.some((id) => id.trim().toLowerCase() === normalizedProvider),
      )
    : undefined;
  const summary = contextNoticeSummary(model, Boolean(currentGroup));
  const percentage = model.complete ? `${model.approximate ? "~" : ""}${model.pct}%` : null;
  const dashOffset = RING_CIRCUMFERENCE * (1 - model.pct / 100);
  const providerCosts = latestProviderCostStats(options.messages);
  // Plan-billed sessions hide dollar estimates: subscription usage is bounded
  // by the plan windows below, and per-token math would misread as real spend.
  // Billing mode is provider-level: session rows do not record which auth
  // profile served the run, so a provider with both an API key and a
  // subscription resolves to subscription display (per-run credential
  // attribution is #102807).
  const showCosts = !currentGroup;
  const usageHref = `${normalizeBasePath(options.providerUsage?.basePath ?? "")}/usage`;
  const formatStat = (value: number | null) =>
    value === null ? t("usage.common.emptyValue") : formatCompactTokenCount(value);
  const renderCostStat = (label: string, value: number | undefined) =>
    value === undefined || value <= 0
      ? nothing
      : html`
          <div>
            <dt>${label}</dt>
            <dd>${formatCost(value)}</dd>
          </div>
        `;
  const hasProviderCosts = providerCosts && Object.values(providerCosts).some((value) => value > 0);
  return html`
    <div
      class="context-usage"
      style=${`--ctx-color:${model.color};--ctx-bg:${model.bg}`}
    >
      <details
        @toggle=${(event: Event) => {
          handleChatComposerDetailsToggle(event);
          const details = event.currentTarget;
          if (details instanceof HTMLDetailsElement) {
            syncChatPickerOverlay(details);
          }
        }}
      >
        <summary
          class="context-ring ${model.warning ? "context-ring--warning" : ""} ${
            model.complete ? "" : "context-ring--unknown"
          }"
          aria-label=${summary}
          title=${t("chat.composer.contextUsage.open")}
        >
          <svg
            class="context-ring__dial"
            viewBox="0 0 16 16"
            width="16"
            height="16"
            aria-hidden="true"
          >
            <circle class="context-ring__track" cx="8" cy="8" r=${RING_RADIUS} />
            <circle
              class="context-ring__fill"
              cx="8"
              cy="8"
              r=${RING_RADIUS}
              stroke-dasharray=${RING_CIRCUMFERENCE.toFixed(2)}
              stroke-dashoffset=${dashOffset.toFixed(2)}
            />
          </svg>
        </summary>
        <wa-popup data-anchored-overlay>
          <section
            class="context-usage__popover"
            aria-label=${t("chat.composer.contextUsage.title")}
          >
            <div class="context-usage__header">
              <span class="context-usage__title"
                >${t(model.fromLastPrompt ? "chat.composer.contextUsage.promptBudget" : "chat.composer.contextUsage.contextWindow")}</span
              >
              <strong class="context-usage__context-value"
                >${percentage ? `${model.detail} · ${percentage}` : model.detail}</strong
              >
            </div>
            ${
              model.complete
                ? html`
                    <div
                      class="context-usage__bar"
                      role="progressbar"
                      aria-label=${summary}
                      aria-valuemin="0"
                      aria-valuemax="100"
                      aria-valuenow=${model.pct}
                    >
                      <span style="width: ${model.pct}%"></span>
                    </div>
                  `
                : html`<div class="context-usage__pending" data-chat-context-pending="true">
                    ${t("chat.composer.contextUsage.pending")}
                  </div>`
            }
            ${
              model.used !== null || model.input !== null || model.output !== null
                ? html`
                    <div class="context-usage__section-label">
                      ${t("chat.composer.contextUsage.latestRunTokens")}
                    </div>
                    <dl class="context-usage__stats">
                      <div>
                        <dt>${t("usage.breakdown.input")}</dt>
                        <dd>${formatStat(model.input)}</dd>
                      </div>
                      <div>
                        <dt>${t("usage.breakdown.output")}</dt>
                        <dd>${formatStat(model.output)}</dd>
                      </div>
                      ${
                        !showCosts || model.cost === null
                          ? nothing
                          : html`
                              <div>
                                <dt>${t("chat.composer.contextUsage.estimatedCost")}</dt>
                                <dd>${formatCost(model.cost)}</dd>
                              </div>
                            `
                      }
                    </dl>
                  `
                : nothing
            }
            ${
              showCosts && providerCosts && hasProviderCosts
                ? html`
                    <div class="context-usage__section-label">
                      ${t("usage.breakdown.costByType")}
                    </div>
                    <dl class="context-usage__stats">
                      ${renderCostStat(t("usage.breakdown.input"), providerCosts.input)}
                      ${renderCostStat(t("usage.breakdown.output"), providerCosts.output)}
                      ${renderCostStat(t("usage.breakdown.cacheRead"), providerCosts.cacheRead)}
                      ${renderCostStat(t("usage.breakdown.cacheWrite"), providerCosts.cacheWrite)}
                    </dl>
                  `
                : nothing
            }
            ${currentGroup ? renderQuotaGroup(currentGroup, usageHref) : nothing}
          </section>
        </wa-popup>
      </details>
    </div>
  `;
}
