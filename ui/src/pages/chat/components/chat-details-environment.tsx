import { For, Loading, Show, createMemo, createSignal, lazy } from "solid-js";
import { CopyButton } from "../../../components/solid/copy-button.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { formatCompactTokenCount } from "../../../lib/format.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { getContextNoticeViewModel } from "./chat-composer-context.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import "../../../styles/chat/context-breakdown.css";

// The report is needed only after Context is expanded, not during chat boot.
const ChatContextBreakdown = lazy(() => import("./chat-context-breakdown.tsx"), {
  export: "ChatContextBreakdown",
});

type Props = { details: ChatDetailsProps; presented: boolean };

export function ChatDetailsEnvironment(props: Props) {
  const workspace = () => props.details.detailsWorkspace;
  const workspaceLabel = createMemo(
    () =>
      workspace()?.label ||
      workspace()
        ?.root?.replace(/[\\/]+$/, "")
        .split(/[\\/]/)
        .pop() ||
      t("chat.sessionDetails.workspaceUnavailable"),
  );
  const session = () => props.details.selectedSession;
  const host = createMemo(() => session()?.execNode ?? session()?.deviceFolder?.deviceId);
  const model = createMemo(() => session()?.activeModel || session()?.model);
  return (
    <details class="chat-details__group chat-details__environment" open>
      <summary class="chat-details__caption">
        {t("chat.sessionDetails.environment")}
        <Icon name="chevronDown" />
      </summary>
      <Show when={host()}>
        <div class="chat-details__row" title={host()}>
          <Icon name="monitor" />
          <span>{host()}</span>
        </div>
      </Show>
      <div class="chat-details__row" title={workspaceLabel()}>
        <Icon name="folder" />
        <div class="chat-details__value">
          <span>{workspaceLabel()}</span>
        </div>
        <Show when={workspace()?.root}>
          {(root) => <CopyButton text={root()} idleLabel={t("chat.sessionHeader.copyPath")} bare />}
        </Show>
      </div>
      <Show when={workspace()?.branch}>
        {(branch) => (
          <div class="chat-details__row" title={branch()}>
            <Icon name="gitBranch" />
            <span>{branch()}</span>
            <Show when={session()?.worktree}>
              <small class="chat-details__badge">{t("chat.sessionDetails.worktree")}</small>
            </Show>
            <CopyButton text={branch()} idleLabel={t("chat.sessionHeader.copyBranch")} bare />
          </div>
        )}
      </Show>
      <Show when={model()}>
        <div class="chat-details__row" title={model()}>
          <Icon name="bot" />
          <span>{model()}</span>
        </div>
      </Show>
      <Show when={props.details.onOpenWorkspace}>
        <button
          class="chat-details__row chat-details__navigation"
          type="button"
          onClick={() => {
            if (props.presented) {
              props.details.onOpenWorkspace?.();
            }
          }}
        >
          <Icon name="fileText" />
          <span>{t("chat.workspaceFiles.showFiles")}</span>
          <Icon name="chevronRight" />
        </button>
      </Show>
    </details>
  );
}

export function ChatDetailsContext(props: Props) {
  const context = createMemo(() => getContextNoticeViewModel(props.details.selectedSession));
  const [expanded, setExpanded] = createSignal(false);
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
        <details
          class="chat-details__group chat-details__context"
          onToggle={(event) => setExpanded(event.currentTarget.open)}
        >
          <summary class="chat-details__caption">
            {t("chat.sessionDetails.context")}
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
            <Icon name="chevronDown" />
          </summary>
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
              expanded() &&
              props.presented &&
              props.details.pullRequestsGateway &&
              props.details.selectedSession
            }
          >
            <Loading
              fallback={
                <p class="chat-context__note" role="status">
                  {t("chat.sessionDetails.contextLoading")}
                </p>
              }
            >
              <ChatContextBreakdown
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
        </details>
      )}
    </Show>
  );
}
