import { parseProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { JSX } from "@solidjs/web";
import { createMemo, For, lazy, Match, Show, Switch } from "solid-js";
import type { ModelCatalogEntry } from "../../../api/types.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { MarkdownHtml } from "../../../components/solid/markdown-html.tsx";
import { ProviderBrandIcon } from "../../../components/solid/provider-icon.tsx";
import type { ChatItem } from "../../../lib/chat/chat-types.ts";
import {
  buildQualifiedChatModelValue,
  normalizeChatModelProviderId,
} from "../../../lib/chat/model-ref.ts";
import { formatTimeMs } from "../../../lib/format.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import { formatModelLabel } from "./chat-model-picker-options.ts";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";

export type ChatNoticeProps = {
  item: Extract<ChatItem, { kind: "notice" }>;
  onPermissionRetry?: (message: string) => void;
  modelCatalog?: ModelCatalogEntry[];
  recovery?: Pick<
    ChatThreadProps,
    "failureActionsRunId" | "runActive" | "runWorking" | "onRetryRun" | "onDismissPendingInput"
  >;
};

// Text-only notices paint with their transcript row; only interactive cards load later.
const ChatPermissionCard = lazy(() => import("./chat-permission-card.tsx"), {
  export: "ChatPermissionCard",
});
const ChatSkillLearnedNotice = lazy(() => import("./chat-skill-learned-notice.tsx"), {
  export: "ChatSkillLearnedNotice",
});

function SystemLine(props: {
  icon?: Extract<ChatItem, { kind: "divider" }>["icon"];
  label: string;
  children?: JSX.Element;
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
        <span class="chat-divider__title">{props.children ?? props.label}</span>
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

function NoticeModel(props: {
  value: string;
  prefix?: string;
  suffix?: string;
  catalog?: ModelCatalogEntry[];
}) {
  const reference = createMemo(() => parseProviderModelRef(props.value));
  const provider = () => normalizeChatModelProviderId(reference()?.provider ?? "");
  const name = createMemo(() => {
    const entry = props.catalog?.find((candidate) => {
      const ref = parseProviderModelRef(
        buildQualifiedChatModelValue(candidate.id, candidate.provider),
      );
      return (
        ref?.model === reference()?.model &&
        normalizeChatModelProviderId(ref?.provider ?? "") === provider()
      );
    });
    return formatModelLabel({
      provider: provider(),
      label: entry?.name.trim() || entry?.alias?.trim() || reference()?.model || props.value,
    });
  });
  return (
    <span class="chat-divider__model" title={props.value}>
      <Show when={props.prefix}>
        <span class="chat-divider__model-affix">{props.prefix}</span>
      </Show>
      <Show when={provider()}>
        <ProviderBrandIcon provider={provider()} class="chat-divider__icon" />
      </Show>
      <bdi>{name()}</bdi>
      <Show when={props.suffix}>
        <span class="chat-divider__model-affix">{props.suffix}</span>
      </Show>
    </span>
  );
}

function ModelChangeLabel(props: {
  change: NonNullable<ChatNoticeProps["item"]["modelChange"]>;
  catalog?: ModelCatalogEntry[];
}) {
  const parts = createMemo(() => t("chat.systemNotice.modelChanged").split(/(\{from\}|\{to\})/u));
  return (
    <>
      {parts()[0]}
      <For each={parts()}>
        {(part, index) =>
          part === "{from}" || part === "{to}" ? (
            <NoticeModel
              value={part === "{from}" ? props.change.from : props.change.to}
              prefix={index() > 1 ? parts()[index() - 1] : undefined}
              suffix={index() === parts().length - 2 ? parts()[index() + 1] : undefined}
              catalog={props.catalog}
            />
          ) : null
        }
      </For>
    </>
  );
}

function OrdinaryNotice(props: ChatNoticeProps) {
  return (
    <div
      class={[
        "chat-notice",
        { "chat-notice--model-change": Boolean(props.item.modelChange) },
        props.item.tone === "danger" ? "chat-notice--danger callout danger" : "",
      ]}
      data-chat-row-key={props.item.key}
      data-ts={String(props.item.timestamp)}
      role={props.item.tone === "danger" ? "alert" : undefined}
    >
      <Show when={props.item.label}>
        <SystemLine
          icon={props.item.modelChange ? undefined : props.item.icon}
          label={props.item.label!}
          metric={props.item.showTimestamp ? formatTimeMs(props.item.timestamp) : undefined}
        >
          <Show when={props.item.modelChange} fallback={props.item.label}>
            {(change) => <ModelChangeLabel change={change()} catalog={props.modelCatalog} />}
          </Show>
        </SystemLine>
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

export function ChatNoticeDetails(props: ChatNoticeProps) {
  return (
    <Switch
      fallback={
        <OrdinaryNotice
          item={props.item}
          recovery={props.recovery}
          modelCatalog={props.modelCatalog}
        />
      }
    >
      <Match when={props.item.permissionMissing}>
        <div data-chat-row-key={props.item.key} data-ts={String(props.item.timestamp)}>
          <ChatLazyBoundary>
            <ChatPermissionCard
              request={props.item.permissionMissing!}
              onRetry={props.onPermissionRetry}
            />
          </ChatLazyBoundary>
        </div>
      </Match>
      <Match when={props.item.collapsedBody && props.item.text}>
        <InlineNotice item={props.item} />
      </Match>
      <Match when={props.item.skillChanges}>
        <div data-chat-row-key={props.item.key} data-ts={String(props.item.timestamp)}>
          <ChatLazyBoundary>
            <ChatSkillLearnedNotice notice={props.item.skillChanges} />
          </ChatLazyBoundary>
        </div>
      </Match>
    </Switch>
  );
}
