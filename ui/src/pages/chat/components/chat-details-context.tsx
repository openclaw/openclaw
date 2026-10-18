import { For, Show, createMemo, createSignal } from "solid-js";
import { formatCompactTokenCount } from "../../../lib/format.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { getContextNoticeViewModel } from "./chat-composer-context.tsx";
import { ChatContextBreakdown } from "./chat-context-breakdown.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";

export type ChatDetailsContextContentProps = {
  details: Pick<
    ChatDetailsProps,
    "selectedSession" | "currentAgentId" | "pullRequestsGateway" | "runActive" | "onCompact"
  >;
  /** True only while the host and this section/page are presented. */
  presented: boolean;
  /** Opt in only from the desktop composition; mobile retains native disclosures. */
  desktop?: boolean;
};

/** Native usage metadata; the caller supplies its platform's heading/chrome. */
export function ChatDetailsContextSummary(props: Pick<ChatDetailsContextContentProps, "details">) {
  const context = createMemo(() => getContextNoticeViewModel(props.details.selectedSession));
  return (
    <Show when={context()}>
      {(usage) => (
        <>
          <span class="chat-details__context-percent">
            {usage().approximate ? "~" : ""}
            {usage().pct}%
          </span>
          <meter
            class="chat-details__meter"
            style={{
              color: usage().approximate
                ? "var(--muted)"
                : usage().pct >= 85
                  ? "var(--danger)"
                  : usage().pct >= 65
                    ? "var(--warn)"
                    : "var(--ok)",
            }}
            min="0"
            max="100"
            value={usage().pct}
            aria-label={t("chat.sessionDetails.context")}
            aria-valuetext={`${usage().approximate ? "~" : ""}${usage().pct}% · ${usage().detail}`}
          />
        </>
      )}
    </Show>
  );
}

/** Shared content, with the existing Context query and compaction owners unchanged. */
export function ChatDetailsContextContent(props: ChatDetailsContextContentProps) {
  const context = createMemo(() => getContextNoticeViewModel(props.details.selectedSession));
  const [compacting, setCompacting] = createSignal(false);
  const budget = () => props.details.selectedSession?.contextBudgetStatus;
  const compact = async () => {
    if (!props.presented || compacting() || props.details.runActive) {
      return;
    }
    setCompacting(true);
    try {
      await props.details.onCompact?.();
    } finally {
      setCompacting(false);
    }
  };
  return (
    <Show when={context()}>
      {(usage) => (
        <>
          <div class="chat-details__context-budget">
            <span>
              {t(
                usage().fromLastPrompt
                  ? "chat.composer.contextUsage.promptBudget"
                  : "chat.composer.contextUsage.contextWindow",
              )}
            </span>
            <strong>{usage().detail}</strong>
          </div>
          <Show
            when={
              props.presented && props.details.pullRequestsGateway && props.details.selectedSession
            }
          >
            <ChatContextBreakdown
              desktop={props.desktop}
              gateway={props.details.pullRequestsGateway!}
              session={props.details.selectedSession!}
              agentId={props.details.currentAgentId ?? undefined}
              used={usage().used}
              limit={usage().limit}
              approximate={usage().approximate}
            />
          </Show>
          <Show when={budget() && !usage().approximate}>
            <p class="chat-context__note">
              {t("chat.sessionDetails.contextHeadroom", {
                tokens: formatCompactTokenCount(Math.max(0, usage().limit - usage().used)),
              })}
            </p>
            <p class="chat-context__note">
              {t("chat.sessionDetails.contextReserve", {
                tokens: formatCompactTokenCount(budget()!.effectiveReserveTokens),
              })}
            </p>
          </Show>
          <Show when={props.details.onCompact}>
            <button
              class="chat-context__compact"
              type="button"
              disabled={!props.presented || compacting() || props.details.runActive}
              onClick={() => void compact()}
            >
              {t(
                compacting()
                  ? "chat.sessionDetails.contextCompacting"
                  : "chat.sessionDetails.contextCompact",
              )}
            </button>
          </Show>
          <Show when={usage().input !== null || usage().output !== null}>
            <div class="chat-details__context-budget">
              <span>{t("chat.composer.contextUsage.latestRunTokens")}</span>
            </div>
            <dl class="chat-details__stats">
              <For each={["input", "output"] as const}>
                {(kind) => (
                  <Show when={usage()[kind] !== null}>
                    <div>
                      <dt>{t(`usage.breakdown.${kind}`)}</dt>
                      <dd>{formatCompactTokenCount(usage()[kind]!)}</dd>
                    </div>
                  </Show>
                )}
              </For>
            </dl>
          </Show>
        </>
      )}
    </Show>
  );
}
