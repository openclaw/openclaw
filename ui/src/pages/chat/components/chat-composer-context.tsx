import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asNullableObjectRecord as readCostRecord } from "@openclaw/normalization-core/record-coerce";
import { For, Loading, Repeat, Show, createMemo, createSignal, lazy } from "solid-js";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../../../../../src/shared/transcript-only-openclaw-assistant.js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { normalizeBasePath } from "../../../app-route-paths.ts";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { ProviderBrandIcon } from "../../../components/solid/provider-icon.tsx";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { formatCompactTokenCount, formatCost } from "../../../lib/format.ts";
import { isMonitoredAuthProvider } from "../../../lib/model-auth.ts";
import {
  collectProviderQuotaGroups,
  type ProviderQuotaGroup,
  type ProviderUsageDisplayProps,
} from "../../../lib/provider-quota-summary.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { resolveSessionContextLimit } from "../../../lib/sessions/context-budget.ts";
import { createChatPickerOverlay } from "./chat-picker-overlay.ts";

registerEnglishCatalog(registerChatComposerEnglish);

const CONTEXT_NOTICE_RATIO = 0.85;
const ChatContextBreakdown = lazy(() => import("./chat-context-breakdown.tsx"), {
  export: "ChatContextBreakdown",
});

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
    if (readCostRecord(readCostRecord(message.usage)?.usageReport)?.state === "unavailable") {
      return null;
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

export function getContextNoticeViewModel(session: GatewaySessionRow | undefined) {
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

function formatContextCost(value: number) {
  return formatCost(value).replace(/(\.\d{2})0$/, "$1");
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

function QuotaGroup(props: { group: ProviderQuotaGroup; usageHref: string }) {
  return (
    <div class="context-usage__tray">
      <div class="context-usage__identity">
        <ProviderBrandIcon provider={props.group.providers[0] ?? props.group.displayName} />
        <span
          class="context-usage__account"
          data-chat-usage-account="true"
          title={props.group.accountEmail ?? props.group.displayName}
        >
          {props.group.accountEmail ?? props.group.displayName}
        </span>
        <a
          class="context-usage__plan-badge"
          href={props.usageHref}
          data-chat-provider-usage="true"
          aria-label={t("chat.composer.contextUsage.openUsage")}
        >
          {props.group.plan || t("tabs.usage")}
        </a>
      </div>
      <div class="context-usage__limits">
        <For each={props.group.windows} keyed={false}>
          {(limit, index) => (
            <QuotaRow
              label={formatUsageWindowLabel(limit().label)}
              usedPercent={limit().usedPercent}
              value={`${limit().usedPercent}%`}
              reset={quotaReset(limit().resetAt)}
              index={index}
            />
          )}
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
      </div>
    </div>
  );
}

function ContextPopoverSkeleton() {
  return (
    <div
      class="context-usage__report-skeleton"
      role="status"
      aria-label={t("chat.sessionDetails.contextLoading")}
    >
      <div class="context-usage__skeleton-bar" />
      <Repeat count={5}>
        {() => (
          <div class="context-usage__skeleton-row">
            <i />
            <span />
            <b />
          </div>
        )}
      </Repeat>
    </div>
  );
}

type ContextNoticeProps = ContextNoticeOptions & {
  session?: GatewaySessionRow;
  gateway?: ApplicationGateway;
  agentId?: string;
  onOpenContext?: () => void;
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
  const colors = () => {
    const context = model();
    return context ? { "--ctx-color": context.color, "--ctx-bg": context.bg } : undefined;
  };
  const dashOffset = () => RING_CIRCUMFERENCE * (1 - (model()?.pct ?? 0) / 100);
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
  return (
    <Show when={Boolean(model() || currentGroup())}>
      {(_visible) => {
        const [open, setOpen] = createSignal(false);
        const [visited, setVisited] = createSignal(false);
        const providerCosts = createMemo(
          () => (open() && model() ? latestProviderCostStats(props.messages) : null),
          { lazy: true },
        );
        const costTitle = () => {
          const costs = providerCosts();
          return costs
            ? (["input", "output", "cacheRead", "cacheWrite"] as const)
                .filter((key) => costs[key] !== undefined && costs[key]! > 0)
                .map((key) => `${t(`usage.breakdown.${key}`)} ${formatContextCost(costs[key]!)}`)
                .join(" · ") || undefined
            : undefined;
        };
        const pickerRef = createChatPickerOverlay((details) => {
          setOpen(details.open);
          if (details.open) {
            setVisited(true);
          }
        });
        let details!: HTMLDetailsElement;
        const openContext = () => {
          details.open = false;
          pickerRef.onToggle();
          props.onOpenContext?.();
        };
        return (
          <div class="context-usage" style={colors()}>
            <details
              ref={(element) => {
                details = element;
                pickerRef.details(element);
              }}
              onClick={pickerRef.onClick}
              onToggle={pickerRef.onToggle}
            >
              <summary
                ref={pickerRef.trigger}
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
              <div
                ref={pickerRef.surface}
                class="oc-overlay chat-picker-overlay"
                data-anchored-overlay
                popover="manual"
              >
                <Show when={visited()}>
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
                          <Show when={props.gateway && props.session}>
                            <Loading fallback={<ContextPopoverSkeleton />}>
                              <ChatContextBreakdown
                                gateway={props.gateway!}
                                session={props.session!}
                                agentId={props.agentId}
                                used={context().used}
                                limit={context().limit}
                                approximate={context().approximate}
                                presented={open()}
                                popover
                                loadingFallback={<ContextPopoverSkeleton />}
                              />
                            </Loading>
                          </Show>
                          <button
                            type="button"
                            class="context-usage__open"
                            disabled={!props.onOpenContext}
                            onClick={openContext}
                          >
                            {t("chat.sessionDetails.contextOpen")}
                            <Icon name="chevronRight" />
                          </button>
                          <div class="context-usage__separator" />
                          <div class="context-usage__latest">
                            <span>{t("chat.composer.contextUsage.latestRun")}</span>
                            <dl class="context-usage__stats">
                              <div>
                                <dt>{t("chat.composer.contextUsage.inputShort")}</dt>
                                <dd>{formatStat(context().input)}</dd>
                              </div>
                              <div>
                                <dt>{t("chat.composer.contextUsage.outputShort")}</dt>
                                <dd>{formatStat(context().output)}</dd>
                              </div>
                              <Show when={showCosts() && context().cost !== null}>
                                <div title={costTitle()}>
                                  <dt>{t("chat.composer.contextUsage.costShort")}</dt>
                                  <dd>{formatContextCost(context().cost!)}</dd>
                                </div>
                              </Show>
                            </dl>
                          </div>
                        </>
                      )}
                    </Show>
                    <Show when={currentGroup()}>
                      {(group) => <QuotaGroup group={group()} usageHref={usageHref()} />}
                    </Show>
                  </section>
                </Show>
              </div>
            </details>
          </div>
        );
      }}
    </Show>
  );
}
