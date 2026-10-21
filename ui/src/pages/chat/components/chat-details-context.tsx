import {
  For,
  Loading,
  Show,
  action,
  createMemo,
  createOptimistic,
  createSignal,
  lazy,
  onSettled,
} from "solid-js";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { formatCompactTokenCount } from "../../../lib/format.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { createTimeout } from "../../../lib/reactive/timers.ts";
import "../../../styles/chat/context-breakdown.css";
import { getContextNoticeViewModel } from "./chat-composer-context.tsx";
import {
  animateDetailsDesktopEntrance,
  ChatDetailsDesktopSection,
} from "./chat-details-desktop-section.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";

registerEnglishCatalog(registerChatComposerEnglish);
registerEnglishCatalog(registerChatSessionEnglish);

// The report is needed only after Context is expanded, not during chat boot.
const ChatContextBreakdown = lazy(() => import("./chat-context-breakdown.tsx"), {
  export: "ChatContextBreakdown",
});

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

/** Session-keyed arrival: cached context is immediate; the first live usage settles before entering. */
export function ChatDetailsDesktopContext(
  props: ChatDetailsContextContentProps & {
    expanded: boolean;
    onExpandedChange: (expanded: boolean) => void;
  },
) {
  const available = createMemo(() =>
    Boolean(getContextNoticeViewModel(props.details.selectedSession)),
  );
  // Preserve the initial availability, then latch the first admitted arrival for this session.
  const [ready, setReady] = createSignal<boolean>((previous) => previous ?? available());
  let entering = false;
  createTimeout(
    () => {
      entering = true;
      setReady(true);
    },
    () => (available() && props.presented && !ready() ? 2_000 : undefined),
  );
  return (
    <Show when={available() && ready()}>
      {(_ready) => {
        let shell!: HTMLDivElement;
        onSettled(() => {
          if (!entering) {
            return undefined;
          }
          entering = false;
          return animateDetailsDesktopEntrance(shell);
        });
        return (
          <div ref={(element) => (shell = element)} class="chat-details-desktop-context">
            <ChatDetailsDesktopSection
              section="context"
              title={t("chat.sessionDetails.context")}
              expanded={props.expanded}
              presented={props.presented}
              onExpandedChange={(expanded) => props.onExpandedChange(expanded)}
              metadata={
                <span class="chat-details-desktop-context-summary">
                  <ChatDetailsContextSummary details={props.details} />
                </span>
              }
            >
              <ChatDetailsContextContent
                desktop
                details={props.details}
                presented={props.presented && props.expanded}
              />
            </ChatDetailsDesktopSection>
          </div>
        );
      }}
    </Show>
  );
}

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
  const [compacting, setCompacting] = createOptimistic(false);
  const budget = () => props.details.selectedSession?.contextBudgetStatus;
  const compact = action(function* () {
    if (!props.presented || compacting() || props.details.runActive) {
      return;
    }
    setCompacting(true);
    yield props.details.onCompact?.();
  });
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
            <Loading
              fallback={
                <PanelLoadingSkeleton
                  variant="file-list"
                  label={t("chat.sessionDetails.contextLoading")}
                  compact
                />
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
            </Loading>
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
