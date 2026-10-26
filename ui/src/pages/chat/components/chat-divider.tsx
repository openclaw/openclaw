import { createMemo, Match, Show, Switch } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { MarkdownHtml } from "../../../components/solid/markdown-html.tsx";
import type { ChatItem } from "../../../lib/chat/chat-types.ts";
import { formatTimeMs } from "../../../lib/format.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import { ChatPermissionCard } from "./chat-permission-card.tsx";
import { ChatRunFailureNotice } from "./chat-run-failure-notice.tsx";
import { ChatSkillLearnedNotice } from "./chat-skill-learned-notice.tsx";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";

function SystemLine(props: {
  icon?: Extract<ChatItem, { kind: "divider" }>["icon"];
  label: string;
  metric?: string;
  compaction?: "active" | "complete";
}) {
  return (
    <div
      class="chat-divider__rule"
      role={props.compaction ? "status" : "separator"}
      aria-live={props.compaction ? "polite" : undefined}
      aria-label={props.metric ? `${props.label}, ${props.metric}` : props.label}
    >
      <span class="chat-divider__line" />
      <span class="chat-divider__label">
        <Show
          when={props.compaction}
          fallback={
            <Show when={props.icon}>
              {(icon) => (
                <span class="chat-divider__icon" aria-hidden="true">
                  <Icon name={icon()} />
                </span>
              )}
            </Show>
          }
        >
          <span class="chat-compaction__glyph" aria-hidden="true">
            <span class="chat-compaction__line" />
            <span class="chat-compaction__line" />
            <span class="chat-compaction__line" />
            <span class="chat-compaction__line" />
            <span class="chat-compaction__line" />
            <Icon name="check" />
          </span>
        </Show>
        <span class="chat-divider__title">{props.label}</span>
        <Show when={props.metric}>
          <span class="chat-divider__separator" aria-hidden="true">
            ·
          </span>
          <span class="chat-divider__metric">{props.metric}</span>
        </Show>
      </span>
      <span class="chat-divider__line" />
    </div>
  );
}

export function ChatDivider(props: { item: Extract<ChatItem, { kind: "divider" }> }) {
  return (
    <div
      class={[
        "chat-divider",
        props.item.compaction ? `chat-compaction chat-compaction--${props.item.compaction}` : "",
      ]}
      data-chat-row-key={props.item.key}
      data-ts={String(props.item.timestamp)}
    >
      <SystemLine
        icon={props.item.icon}
        label={props.item.label}
        metric={props.item.metric}
        compaction={props.item.compaction}
      />
      <Show when={props.item.description}>
        <div class="chat-divider__details">
          <span class="chat-divider__description">{props.item.description}</span>
        </div>
      </Show>
    </div>
  );
}

type ChatNoticeRecovery = Pick<
  ChatThreadProps,
  "failureActionsRunId" | "runActive" | "runWorking" | "onRetryRun" | "onDismissPendingInput"
>;

type ChatNoticeProps = {
  item: Extract<ChatItem, { kind: "notice" }>;
  onPermissionRetry?: (message: string) => void;
  recovery?: ChatNoticeRecovery;
};

function FailureNotice(props: ChatNoticeProps) {
  const failure = () => props.item.runError!;
  const actions = createMemo(() => {
    const runId = failure().runId;
    const recovery = props.recovery;
    if (
      !recovery ||
      runId !== recovery.failureActionsRunId ||
      recovery.runActive ||
      recovery.runWorking
    ) {
      return undefined;
    }
    return {
      onRetry: recovery.onRetryRun ? () => recovery.onRetryRun?.(runId) : undefined,
    };
  });
  return (
    <div
      data-chat-row-key={props.item.key}
      data-ts={String(props.item.timestamp)}
      data-run-failure={failure().runId}
    >
      <ChatRunFailureNotice
        summary={failure().summary}
        repeatCount={props.item.repeatCount}
        onRetry={actions()?.onRetry}
      />
    </div>
  );
}

function NoticeBody(props: { text: string }) {
  return (
    <MarkdownHtml
      class="chat-text chat-notice__body"
      dir={detectTextDirection(props.text)}
      markdown={props.text}
      options={{ codeBlockChrome: "none" }}
    />
  );
}

/** Context injected mid-run reads as part of the agent's turn, not as a session divider. */
function InlineNotice(props: ChatNoticeProps) {
  return (
    <details
      class="chat-notice-inline"
      data-chat-row-key={props.item.key}
      data-ts={String(props.item.timestamp)}
    >
      <summary>
        <span class="chat-notice-inline__icon" aria-hidden="true">
          <Icon name={props.item.icon ?? "cpu"} />
        </span>
        <strong class="chat-notice-inline__label">{props.item.label}</strong>
        <Show when={props.item.showTimestamp}>
          <span class="chat-notice-inline__time">{formatTimeMs(props.item.timestamp)}</span>
        </Show>
        <span class="chat-notice-inline__chevron" aria-hidden="true">
          <Icon name="chevronRight" />
        </span>
      </summary>
      <NoticeBody text={props.item.text} />
    </details>
  );
}

function OrdinaryNotice(props: ChatNoticeProps) {
  return (
    <div
      class={[
        "chat-notice",
        props.item.tone === "danger" ? "chat-notice--danger callout danger" : "",
      ]}
      data-chat-row-key={props.item.key}
      data-ts={String(props.item.timestamp)}
      role={props.item.tone === "danger" ? "alert" : undefined}
    >
      <Show when={props.item.label}>
        <SystemLine
          icon={props.item.icon}
          label={props.item.label!}
          metric={props.item.showTimestamp ? formatTimeMs(props.item.timestamp) : undefined}
        />
      </Show>
      <Show when={props.item.text}>
        <NoticeBody text={props.item.text} />
      </Show>
      <Show when={props.item.retiredPendingInput}>
        {(retired) => (
          <Show when={props.recovery?.onDismissPendingInput}>
            {(dismiss) => (
              <div class="chat-notice__actions">
                <button
                  class="btn btn--sm"
                  type="button"
                  aria-label={t(
                    retired().status === "interrupted"
                      ? "chat.pendingInputs.dismissInterrupted"
                      : "chat.pendingInputs.dismissCancelled",
                    { preview: retired().preview },
                  )}
                  onClick={() => dismiss()(retired().id)}
                >
                  {t("chat.pendingInputs.dismiss")}
                </button>
              </div>
            )}
          </Show>
        )}
      </Show>
    </div>
  );
}

export function ChatNotice(props: ChatNoticeProps) {
  return (
    <Switch fallback={<OrdinaryNotice item={props.item} recovery={props.recovery} />}>
      <Match when={props.item.runError}>
        <FailureNotice item={props.item} recovery={props.recovery} />
      </Match>
      <Match when={props.item.permissionMissing}>
        <div data-chat-row-key={props.item.key} data-ts={String(props.item.timestamp)}>
          <ChatPermissionCard
            request={props.item.permissionMissing!}
            onRetry={props.onPermissionRetry}
          />
        </div>
      </Match>
      <Match when={props.item.collapsedBody && props.item.text}>
        <InlineNotice item={props.item} />
      </Match>
      <Match when={props.item.skillChanges}>
        <div data-chat-row-key={props.item.key} data-ts={String(props.item.timestamp)}>
          <ChatSkillLearnedNotice notice={props.item.skillChanges} />
        </div>
      </Match>
    </Switch>
  );
}
