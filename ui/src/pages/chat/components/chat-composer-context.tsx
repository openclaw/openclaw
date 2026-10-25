import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asNullableObjectRecord as readCostRecord } from "@openclaw/normalization-core/record-coerce";
import { Loading, Repeat, Show, createMemo, createSignal, lazy } from "solid-js";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../../../../../src/shared/transcript-only-openclaw-assistant.js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { formatCompactTokenCount } from "../../../lib/format.ts";
import { isMonitoredAuthProvider } from "../../../lib/model-auth.ts";
import {
  collectProviderQuotaGroups,
  type ProviderUsageDisplayProps,
} from "../../../lib/provider-quota-summary.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { resolveSessionContextLimit } from "../../../lib/sessions/context-budget.ts";
import { createChatPickerOverlay } from "./chat-picker-overlay.ts";

registerEnglishCatalog(registerChatComposerEnglish);

const CONTEXT_NOTICE_RATIO = 0.85;
const ChatComposerContextPanel = lazy(() => import("./chat-composer-context-panel.tsx"), {
  export: "ChatComposerContextPanel",
});

type ContextNoticeOptions = {
  messages?: unknown[];
  providerUsage?: ProviderUsageDisplayProps;
};

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

export function ContextPopoverSkeleton() {
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

export type ContextNoticeProps = ContextNoticeOptions & {
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
  return (
    <Show when={Boolean(model() || currentGroup())}>
      {(_visible) => {
        const [open, setOpen] = createSignal(false);
        const [visited, setVisited] = createSignal(false);
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
                  <Loading fallback={<ContextPopoverSkeleton />}>
                    <ChatComposerContextPanel
                      {...props}
                      model={model()}
                      currentGroup={currentGroup()}
                      open={open()}
                      onOpenContext={props.onOpenContext ? openContext : undefined}
                    />
                  </Loading>
                </Show>
              </div>
            </details>
          </div>
        );
      }}
    </Show>
  );
}
