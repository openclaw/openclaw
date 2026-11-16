import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asNullableObjectRecord as readCostRecord } from "@openclaw/normalization-core/record-coerce";
import { Errored, Loading, Repeat, Show, createMemo, lazy } from "solid-js";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../../../../../src/shared/transcript-only-openclaw-assistant.js";
import { normalizeBasePath } from "../../../app-route-paths.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { MenuHeading } from "../../../components/solid/menu-heading.tsx";
import { ProviderBrandIcon } from "../../../components/solid/provider-icon.tsx";
import { formatCompactTokenCount, formatCost } from "../../../lib/format.ts";
import type { ProviderQuotaGroup } from "../../../lib/provider-quota-summary.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { promptCacheHitRate } from "../../../lib/sessions/usage.ts";
import type {
  ContextNoticeProps,
  getContextNoticeViewModel,
} from "./chat-composer-context-model.ts";
import { ContextCompactButton } from "./chat-context-compact.tsx";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";

const ChatContextBreakdown = lazy(() => import("./chat-context-breakdown.tsx"), {
  export: "ChatContextBreakdown",
});
const ChatSessionCost = lazy(() => import("./chat-context-breakdown.tsx"), {
  export: "ChatSessionCost",
});
const ModelProviderIcon = lazy(() => import("../../../lib/reactive/provider-presentation.tsx"), {
  export: "ModelProviderIcon",
});
const QuotaMetrics = lazy(() => import("./chat-composer-quota-metrics.tsx"));

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

/** Prompt cache share across every model call since the latest user message; null when
 *  any call did not report its usage or cache split, so an unknown is never shown as a miss. */
function latestRunCacheHitRate(messages: unknown[] | undefined): number | null {
  const totals = { input: 0, cacheRead: 0, cacheWrite: 0 };
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = readCostRecord(messages?.[index]);
    if (message?.role === "user") {
      break;
    }
    if (message?.role !== "assistant" || isTranscriptOnlyOpenClawAssistantMessage(message)) {
      continue;
    }
    const usage = readCostRecord(message.usage);
    if (
      readCostRecord(usage?.usageReport)?.state === "unavailable" ||
      readCostRecord(usage?.cacheTelemetry)?.state === "unavailable"
    ) {
      return null;
    }
    for (const key of ["input", "cacheRead", "cacheWrite"] as const) {
      totals[key] += asNonNegativeFiniteNumber(usage?.[key]) ?? 0;
    }
  }
  return promptCacheHitRate(totals);
}

// Floor so 100% only appears when every prompt token was a cache read.
function CacheHitRate(props: { rate: number }) {
  return (
    <div title={t("chat.composer.contextUsage.cacheHitRate")}>
      <dt>{t("chat.composer.contextUsage.cacheShort")}</dt>
      <dd>{(Math.floor(props.rate * 10_000) / 100).toFixed(2)}%</dd>
    </div>
  );
}

function formatContextCost(value: number) {
  return formatCost(value).replace(/(\.\d{2})0$/, "$1");
}

function QuotaGroup(props: { group: ProviderQuotaGroup; usageHref: string }) {
  const provider = () => props.group.providers[0] ?? props.group.displayName;
  const icon = () => <ProviderBrandIcon provider={provider()} />;
  return (
    <div class="context-usage__tray">
      <div class="context-usage__identity">
        <Errored fallback={icon}>
          <Loading fallback={icon()}>
            <ModelProviderIcon provider={provider()} />
          </Loading>
        </Errored>
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
        <ChatLazyBoundary
          fallback={
            // Preserve the known row count and CSS geometry while only the metrics load.
            <Repeat count={props.group.windows.length + props.group.budgets.length}>
              {() => <div class="context-usage__limit" aria-hidden="true" />}
            </Repeat>
          }
        >
          <QuotaMetrics group={props.group} />
        </ChatLazyBoundary>
      </div>
    </div>
  );
}

export function ChatComposerContextPanel(
  props: ContextNoticeProps & {
    model: ReturnType<typeof getContextNoticeViewModel>;
    currentGroup: ProviderQuotaGroup | undefined;
    hasSubscription: boolean;
    quotaUnknown: boolean;
    open: boolean;
  },
) {
  // Plan-billed sessions hide dollar estimates: subscription usage is bounded
  // by the plan windows below, and per-token math would misread as real spend.
  // Billing classification is independent of account-specific quota availability.
  const showCosts = () => !props.currentGroup && !props.hasSubscription;
  const usageHref = () => `${normalizeBasePath(props.providerUsage?.basePath ?? "")}/usage`;
  const formatStat = (value: number | null) =>
    value === null ? t("usage.common.emptyValue") : formatCompactTokenCount(value);
  const providerCosts = createMemo(
    () => (props.open && props.model ? latestProviderCostStats(props.messages) : null),
    { lazy: true },
  );
  const runCacheHitRate = createMemo(
    () => (props.open && props.model ? latestRunCacheHitRate(props.messages) : null),
    { lazy: true },
  );
  const showRunCost = () => showCosts() && props.model?.cost !== null;
  const costTitle = () => {
    const costs = providerCosts();
    return costs
      ? (["input", "output", "cacheRead", "cacheWrite"] as const)
          .filter((key) => costs[key] !== undefined && costs[key]! > 0)
          .map((key) => `${t(`usage.breakdown.${key}`)} ${formatContextCost(costs[key]!)}`)
          .join(" · ") || undefined
      : undefined;
  };
  return (
    <section class="context-usage__popover" aria-label={t("chat.composer.contextUsage.title")}>
      <Show when={props.model}>
        {(context) => (
          <>
            <MenuHeading
              class="context-usage__header"
              label={t(
                context().fromLastPrompt
                  ? "chat.composer.contextUsage.promptBudget"
                  : "chat.composer.contextUsage.contextWindow",
              )}
              trailing={
                /* Translation replaces the text anchors used by live token updates. */
                <strong class="oc-menu-heading__value context-usage__context-value" translate="no">
                  {context().detail} · {context().approximate ? "~" : ""}
                  {context().pct}%
                </strong>
              }
            />
            <Show when={props.gateway && props.session}>
              <Loading fallback={<ContextPopoverSkeleton />}>
                <ChatContextBreakdown
                  gateway={props.gateway!}
                  session={props.session!}
                  agentId={props.agentId}
                  used={context().used}
                  limit={context().limit}
                  approximate={context().approximate}
                  presented={props.open}
                  popover
                  loadingFallback={<ContextPopoverSkeleton />}
                />
              </Loading>
            </Show>
            <div class="context-usage__actions">
              <button
                type="button"
                class="context-usage__open"
                disabled={!props.onOpenContext}
                onClick={() => props.onOpenContext?.()}
              >
                {t("chat.sessionDetails.contextOpen")}
                <Icon name="chevronRight" />
              </button>
              {/* A secondary action beside View context: the ring already carries the warning.
                  Compacting keeps the popover open so the budget above shows the result. */}
              <ContextCompactButton
                onCompact={props.onCompact}
                compactionStatus={props.compactionStatus}
                runActive={props.runActive}
                connected={props.connected !== false}
              />
            </div>
            <div class="context-usage__separator" />
            {/* Two rows, one per scope. A priced run shows cost and moves its token counts
                into the row tooltip; a plan-billed run keeps them, since it has no cost. */}
            <div
              class="context-usage__latest"
              title={
                showRunCost()
                  ? `${t("chat.composer.contextUsage.inputShort")} ${formatStat(context().input)} · ${t("chat.composer.contextUsage.outputShort")} ${formatStat(context().output)}`
                  : undefined
              }
            >
              <span>{t("chat.composer.contextUsage.latestRun")}</span>
              <dl class="context-usage__stats">
                <Show when={!showRunCost()}>
                  <div>
                    <dt>{t("chat.composer.contextUsage.inputShort")}</dt>
                    <dd>{formatStat(context().input)}</dd>
                  </div>
                  <div>
                    <dt>{t("chat.composer.contextUsage.outputShort")}</dt>
                    <dd>{formatStat(context().output)}</dd>
                  </div>
                </Show>
                <Show when={runCacheHitRate() !== null}>
                  <CacheHitRate rate={runCacheHitRate()!} />
                </Show>
                <Show when={showRunCost()}>
                  <div title={costTitle()}>
                    <dt>{t("chat.composer.contextUsage.costShort")}</dt>
                    <dd>{formatContextCost(context().cost!)}</dd>
                  </div>
                </Show>
              </dl>
            </div>
            <Show when={props.gateway && props.session}>
              <Loading>
                <ChatSessionCost
                  gateway={props.gateway!}
                  session={props.session!}
                  agentId={props.agentId}
                  used={context().used}
                  presented={props.open}
                >
                  {(total) => (
                    <Show when={showCosts() || total().cacheHitRate !== null}>
                      <div class="context-usage__latest" data-chat-session-cost="true">
                        <span>{t("chat.composer.contextUsage.sessionTotal")}</span>
                        <dl class="context-usage__stats">
                          <Show when={total().cacheHitRate !== null}>
                            <CacheHitRate rate={total().cacheHitRate!} />
                          </Show>
                          <Show when={showCosts()}>
                            <div>
                              <dt>{t("chat.composer.contextUsage.costShort")}</dt>
                              <dd>
                                {total().unpriced
                                  ? t("chat.composer.contextUsage.unpriced")
                                  : (total().partial ? "≥ " : "") + formatContextCost(total().usd)}
                              </dd>
                            </div>
                          </Show>
                        </dl>
                      </div>
                    </Show>
                  )}
                </ChatSessionCost>
              </Loading>
            </Show>
          </>
        )}
      </Show>
      <Show when={props.currentGroup}>
        {(group) => <QuotaGroup group={group()} usageHref={usageHref()} />}
      </Show>
      <Show when={props.quotaUnknown}>
        <p class="context-usage__stats" role="status">
          {t("chat.composer.contextUsage.quotaAccountUnknown")}
        </p>
      </Show>
    </section>
  );
}
