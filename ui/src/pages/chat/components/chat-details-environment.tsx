import { Show, createMemo } from "solid-js";
import { CopyButton } from "../../../components/solid/copy-button.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { formatCompactTokenCount } from "../../../lib/format.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { getContextNoticeViewModel } from "./chat-composer-context.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";

type Props = { details: ChatDetailsProps; presented: boolean };

export function ChatDetailsEnvironment(props: Props) {
  const workspace = () => props.details.detailsWorkspace;
  const workspaceLabel = () =>
    workspace()?.label ||
    workspace()
      ?.root?.replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ||
    t("chat.sessionDetails.workspaceUnavailable");
  const session = () => props.details.selectedSession;
  const host = () => session()?.execNode ?? session()?.deviceFolder?.deviceId;
  const model = () => session()?.activeModel || session()?.model;
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
  return (
    <Show when={context()}>
      {(usage) => (
        <details class="chat-details__group chat-details__context">
          <summary class="chat-details__caption">
            {t("chat.sessionDetails.context")}
            <span class="chat-details__context-percent">
              {usage().approximate ? "~" : ""}
              {usage().pct}%
            </span>
            <meter
              class="chat-details__meter"
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
          <Show when={usage().input !== null || usage().output !== null}>
            <div class="chat-details__context-budget">
              <span>{t("chat.composer.contextUsage.latestRunTokens")}</span>
            </div>
            <dl class="chat-details__stats">
              <Show when={usage().input !== null}>
                <div>
                  <dt>{t("usage.breakdown.input")}</dt>
                  <dd>{formatCompactTokenCount(usage().input!)}</dd>
                </div>
              </Show>
              <Show when={usage().output !== null}>
                <div>
                  <dt>{t("usage.breakdown.output")}</dt>
                  <dd>{formatCompactTokenCount(usage().output!)}</dd>
                </div>
              </Show>
            </dl>
          </Show>
        </details>
      )}
    </Show>
  );
}
