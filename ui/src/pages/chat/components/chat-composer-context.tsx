import { Show, createMemo, createSignal } from "solid-js";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { formatCompactTokenCount } from "../../../lib/format.ts";
import { isMonitoredAuthProvider, providerUsageForAccount } from "../../../lib/model-auth.ts";
import type {
  ProviderQuotaGroup,
  ProviderQuotaSelection,
} from "../../../lib/provider-quota-summary.ts";
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
  const model = createMemo(() =>
    getContextNoticeViewModel(
      props.session,
      props.session?.totalTokens === undefined && props.session?.totalTokensFresh === undefined
        ? props.contextUsage
        : undefined,
    ),
  );
  const providers = createMemo(() => {
    const currentProvider = (
      props.session?.modelProvider?.trim() || latestAssistantProvider(props.messages)
    )?.toLowerCase();
    return currentProvider
      ? (props.providerUsage?.modelAuthStatusResult?.providers ?? []).filter((provider) =>
          [provider.provider, provider.usage?.providerId].some(
            (id) => id?.trim().toLowerCase() === currentProvider,
          ),
        )
      : [];
  });
  // Usage does not attribute each run to a credential yet. Keep mixed providers
  // conservative: missing account-specific quota does not imply token billing.
  const hasSubscription = createMemo(() =>
    providers().some((provider) =>
      provider.profiles.some((profile) => profile.type === "oauth" || profile.type === "token"),
    ),
  );
  const quota = createMemo<ProviderQuotaSelection>(() => {
    const available = providers().filter(
      (provider) => isMonitoredAuthProvider(provider) && provider.usage,
    );
    if (available.length === 0) {
      return { status: "unavailable" };
    }
    const profileId =
      props.accountSelection?.kind === "automatic"
        ? undefined
        : props.accountSelection?.authProfileId;
    const selected = available.filter((provider) => providerUsageForAccount(provider, profileId));
    const provider = selected[0];
    const usage = provider?.usage;
    // Alias rows share the Gateway's canonical usage snapshot. Distinct usage
    // providers remain ambiguous; presentation labels cannot identify an account.
    if (
      !provider ||
      !usage ||
      selected.some((candidate) => candidate.usage?.providerId !== usage.providerId)
    ) {
      return { status: "unknown" };
    }
    const windows = usage.windows ?? [];
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
      return [entry];
    });
    if (windows.length === 0 && budgets.length === 0) {
      return { status: "unavailable" };
    }
    return {
      status: "known",
      group: {
        providers: [provider.provider],
        displayName: provider.displayName,
        plan: usage.plan,
        accountEmail: usage.accountEmail,
        windows,
        budgets,
      },
    };
  });
  const currentGroup = () => quota().group;
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
  const tooltip = () => {
    const context = model();
    return context
      ? t("chat.composer.contextUsage.percentUsed", {
          pct: `${context.approximate ? "~" : ""}${context.pct}`,
        })
      : summary();
  };
  const colors = () => {
    const context = model();
    return context ? { "--ctx-color": context.color, "--ctx-bg": context.bg } : undefined;
  };
  const dashOffset = () => RING_CIRCUMFERENCE * (1 - (model()?.pct ?? 0) / 100);
  return (
    <Show when={Boolean(model() || quota().status !== "unavailable")}>
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
                title={tooltip()}
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
                    quotaUnknown={quota().status === "unknown"}
                    hasSubscription={hasSubscription()}
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
