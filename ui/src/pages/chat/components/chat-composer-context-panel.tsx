import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asNullableObjectRecord as readCostRecord } from "@openclaw/normalization-core/record-coerce";
import { Errored, For, Loading, Repeat, Show, createMemo, lazy } from "solid-js";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../../../../../src/shared/transcript-only-openclaw-assistant.js";
import { normalizeBasePath } from "../../../app-route-paths.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { MenuHeading } from "../../../components/solid/menu-heading.tsx";
import { ProviderBrandIcon } from "../../../components/solid/provider-icon.tsx";
import { formatCompactTokenCount, formatCost } from "../../../lib/format.ts";
import type { ProviderQuotaGroup } from "../../../lib/provider-quota-summary.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { SessionCostTotal } from "../../../lib/session-context-report.ts";
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

/** Prompt cache share across the model calls since the latest user message that reported
 *  a cache split; a call with unknown usage or cache use is left out, never counted as a miss. */
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
      continue;
    }
    for (const key of ["input", "cacheRead", "cacheWrite"] as const) {
      totals[key] += asNonNegativeFiniteNumber(usage?.[key]) ?? 0;
    }
  }
  return promptCacheHitRate(totals);
}

// Floors, so 100.00% only appears when every prompt token was a cache read.
const formatCacheHitRate = (rate: number | null) =>
  rate === null ? "—" : `${(Math.floor(rate * 10_000) / 100).toFixed(2)}%`;

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
  const costTitle = () => {
    const costs = providerCosts();
    return costs
      ? (["input", "output", "cacheRead", "cacheWrite"] as const)
          .filter((key) => costs[key] !== undefined && costs[key]! > 0)
          .map((key) => `${t(`usage.breakdown.${key}`)} ${formatContextCost(costs[key]!)}`)
          .join(" · ") || undefined
      : undefined;
  };
  /** One small table, one row per scope, and every row has the same columns: cache hit
   *  rate and cost when known, else token counts. Token counts not shown as columns live
   *  in each row label's tooltip. */
  const UsageTable = (table: { total: () => SessionCostTotal | null }) => {
    const context = () => props.model!;
    const columns = (): ("input" | "output" | "cache" | "cost")[] => {
      const shown: ("cache" | "cost")[] = [];
      // Either scope's rate earns the column; the other shows a dash.
      if (runCacheHitRate() !== null || (table.total()?.cacheHitRate ?? null) !== null) {
        shown.push("cache");
      }
      if (showCosts()) {
        shown.push("cost");
      }
      return shown.length > 0 ? shown : ["input", "output"];
    };
    const tokensTitle = (input: number | null, output: number | null, partial = false) =>
      columns().includes("input")
        ? undefined
        : `${t("chat.composer.contextUsage.inputShort")} ${partial ? "≥ " : ""}${formatStat(input)} · ${t("chat.composer.contextUsage.outputShort")} ${partial ? "≥ " : ""}${formatStat(output)}`;
    return (
      <div
        class="context-usage__usage"
        role="table"
        aria-label={t("chat.composer.contextUsage.title")}
        style={{ "grid-template-columns": `1fr repeat(${columns().length}, auto)` }}
      >
        <div class="context-usage__usage-row context-usage__usage-head" role="row">
          <span role="columnheader" />
          <For each={columns()}>
            {(column) => (
              <span
                role="columnheader"
                title={
                  column === "cache" ? t("chat.composer.contextUsage.cacheHitRate") : undefined
                }
              >
                {t(`chat.composer.contextUsage.${column}Short`)}
              </span>
            )}
          </For>
        </div>
        <div class="context-usage__usage-row" role="row" data-chat-usage-row="run">
          <span role="rowheader" title={tokensTitle(context().input, context().output)}>
            {t("chat.composer.contextUsage.latestRun")}
          </span>
          <For each={columns()}>
            {(column) => (
              <b role="cell" title={column === "cost" ? costTitle() : undefined}>
                {column === "input"
                  ? formatStat(context().input)
                  : column === "output"
                    ? formatStat(context().output)
                    : column === "cache"
                      ? formatCacheHitRate(runCacheHitRate())
                      : context().cost === null
                        ? "—"
                        : formatContextCost(context().cost!)}
              </b>
            )}
          </For>
        </div>
        <Show when={table.total()}>
          {(total) => {
            const bound = (value: string) => (total().partial ? "≥ " : "") + value;
            return (
              <div class="context-usage__usage-row" role="row" data-chat-session-cost="true">
                <span
                  role="rowheader"
                  title={tokensTitle(total().input, total().output, total().partial)}
                >
                  {t("chat.composer.contextUsage.sessionTotal")}
                </span>
                <For each={columns()}>
                  {(column) => (
                    <b role="cell">
                      {column === "input"
                        ? bound(formatStat(total().input))
                        : column === "output"
                          ? bound(formatStat(total().output))
                          : column === "cache"
                            ? formatCacheHitRate(total().cacheHitRate)
                            : total().unpriced
                              ? t("chat.composer.contextUsage.unpriced")
                              : bound(formatContextCost(total().usd))}
                    </b>
                  )}
                </For>
              </div>
            );
          }}
        </Show>
      </div>
    );
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
            <Show
              when={props.gateway && props.session}
              fallback={<UsageTable total={() => null} />}
            >
              <Loading fallback={<UsageTable total={() => null} />}>
                <ChatSessionCost
                  gateway={props.gateway!}
                  session={props.session!}
                  agentId={props.agentId}
                  used={context().used}
                  presented={props.open}
                >
                  {(total) => <UsageTable total={total} />}
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
