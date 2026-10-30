import { Show, createMemo, createSignal } from "solid-js";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { formatCompactTokenCount } from "../../../lib/format.ts";
import { isMonitoredAuthProvider } from "../../../lib/model-auth.ts";
import type { ProviderQuotaGroup } from "../../../lib/provider-quota-summary.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import {
  getContextNoticeViewModel,
  latestAssistantProvider,
  type ContextNoticeProps,
} from "./chat-composer-context-model.ts";
// Opening the native popover must expose its summary and focus targets in the same frame.
import { ChatComposerContextPanel } from "./chat-composer-context-panel.tsx";
import { createChatPickerOverlay } from "./chat-picker-overlay.ts";

registerEnglishCatalog(registerChatComposerEnglish);

const RING_RADIUS = 6.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function ContextNotice(props: ContextNoticeProps) {
  const model = createMemo(() => getContextNoticeViewModel(props.session));
  const currentGroup = createMemo(() => {
    const currentProvider = (
      props.session?.modelProvider?.trim() || latestAssistantProvider(props.messages)
    )?.toLowerCase();
    if (!currentProvider || !props.providerUsage) {
      return undefined;
    }
    const groups = new Map<string, ProviderQuotaGroup>();
    for (const provider of (props.providerUsage.modelAuthStatusResult?.providers ?? []).filter(
      isMonitoredAuthProvider,
    )) {
      const usage = provider.usage;
      if (!usage) {
        continue;
      }
      const windows: ProviderQuotaGroup["windows"] = (usage.windows ?? []).map((limit) =>
        Object.assign(
          {
            label: (limit.label || "").trim(),
            usedPercent: Math.max(0, Math.min(100, Math.round(limit.usedPercent))),
          },
          limit.resetAt !== undefined ? { resetAt: limit.resetAt } : {},
        ),
      );
      const budgets: ProviderQuotaGroup["budgets"] = (usage.billing ?? []).flatMap((entry) => {
        if (
          entry.type !== "budget" ||
          !Number.isFinite(entry.used) ||
          !Number.isFinite(entry.limit) ||
          entry.used < 0 ||
          entry.limit <= 0
        ) {
          return [];
        }
        return [
          {
            used: entry.used,
            limit: entry.limit,
            unit: entry.unit,
            ...(entry.label ? { label: entry.label } : {}),
          },
        ];
      });
      if (windows.length === 0 && budgets.length === 0) {
        continue;
      }
      // Session rows report canonical model providers while auth rows may use
      // CLI aliases (claude-cli vs anthropic); expose both ids for matching.
      const providerIds = [
        ...new Set([provider.provider, usage.providerId].filter((id): id is string => Boolean(id))),
      ];
      const identity = JSON.stringify([
        provider.displayName,
        usage.accountEmail ?? null,
        windows,
        budgets,
      ]);
      const existing = groups.get(identity);
      if (existing) {
        for (const id of providerIds) {
          if (!existing.providers.includes(id)) {
            existing.providers.push(id);
          }
        }
        continue;
      }
      groups.set(identity, {
        providers: providerIds,
        displayName: provider.displayName,
        ...(usage.plan ? { plan: usage.plan } : {}),
        ...(usage.accountEmail ? { accountEmail: usage.accountEmail } : {}),
        windows,
        budgets,
      });
    }
    return [...groups.values()].find((group) =>
      group.providers.some((id) => id.trim().toLowerCase() === currentProvider),
    );
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
                  <ChatComposerContextPanel
                    {...props}
                    model={model()}
                    currentGroup={currentGroup()}
                    open={open()}
                    onOpenContext={props.onOpenContext ? openContext : undefined}
                  />
                </Show>
              </div>
            </details>
          </div>
        );
      }}
    </Show>
  );
}
