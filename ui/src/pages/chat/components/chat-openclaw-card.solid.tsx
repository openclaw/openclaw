import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { flattenMarkdownToPlainText } from "@openclaw/normalization-core/markdown-plain-text";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, Show } from "solid-js";
import { inferControlUiPublicAssetPath } from "../../../app/public-assets.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { AgentIdentityAvatar } from "../../../components/solid/identity-avatar.tsx";
import { MarkdownHtml } from "../../../components/solid/markdown-html.tsx";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import { registerChatToolLabelsEnglish } from "../../../i18n/locales/en-chat-tool-labels.ts";
import { resolveToolCardOutcome } from "../../../lib/chat/tool-cards.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { DEFAULT_AGENT_ID } from "../../../lib/sessions/session-key.ts";
import type { ToolCardProps } from "./chat-tool-card-types.ts";

registerEnglishCatalog(registerChatToolLabelsEnglish);
registerEnglishCatalog(registerChatMessageMetadataEnglish);

export function OpenClawCard(props: ToolCardProps) {
  const outcome = () => resolveToolCardOutcome(props.card, props.options.runActive);
  const running = () => outcome() === "running";
  const failed = () => outcome() === "failed";
  const request = createMemo(() => {
    const message = asNullableRecord(props.card.args)?.message;
    return typeof message === "string" ? message : (props.card.inputText ?? "");
  });
  const result = createMemo(
    () => asNullableRecord(props.card.details) ?? safeParseJsonRecord(props.card.outputText ?? ""),
  );
  const reply = () => {
    const value = result()?.reply;
    return typeof value === "string" ? value : "";
  };
  const error = () => {
    const value = result()?.error;
    return typeof value === "string" ? value : props.card.outputText;
  };
  const preview = createMemo(() =>
    flattenMarkdownToPlainText(
      reply()
        .trim()
        .split(/\n\s*\n/u)[0] ?? "",
    ),
  );
  const agentName = () =>
    props.options.assistantName ?? props.options.agentId ?? t("chat.messages.agentName");
  return (
    <div class="chat-ask-card">
      <button
        class="chat-ask-card__header"
        type="button"
        aria-expanded={props.options.expanded ? "true" : "false"}
        onClick={() => props.options.onToggleExpanded(props.card.id)}
      >
        <span class="chat-ask-card__layer" aria-hidden="true">
          <span class="chat-ask-card__mark">
            <Show when={running()} fallback={<Icon name="lobster" />}>
              <img src={inferControlUiPublicAssetPath("favicon.svg")} alt="" />
            </Show>
          </span>
          <AgentIdentityAvatar
            class="chat-ask-card__avatar"
            cachedOnly={props.options.mediaReadAllowed === false}
            agent={{
              id: props.options.agentId ?? DEFAULT_AGENT_ID,
              avatar: props.options.assistantAvatar,
              textAvatar: props.options.assistantTextAvatar,
            }}
          />
        </span>
        <span class="chat-ask-card__text">
          <span class={["chat-ask-card__title", { "chat-ask-card__error": failed() }]}>
            <Show
              when={running()}
              fallback={failed() ? t("chat.toolCards.openclawUnreachable") : preview()}
            >
              <span class="chat-ask-card__shimmer">{t("chat.toolCards.askingOpenclaw")}</span>
            </Show>
          </span>
          <span class="chat-ask-card__subtitle">
            {t("chat.toolCards.askedOpenclaw", { agent: agentName() })}
          </span>
        </span>
        <span class="chat-ask-card__right">
          <Show when={failed()}>
            <span class="chat-ask-card__pill">{t("common.failed")}</span>
          </Show>
          <span class="chat-ask-card__chevron" aria-hidden="true">
            <Icon name="chevronRight" />
          </span>
        </span>
      </button>
      <Show when={props.options.expanded}>
        <div class="chat-ask-card__body">
          <div>
            <div class="chat-ask-card__label">{t("chat.toolCards.openclawRequest")}</div>
            <div class="chat-ask-card__request">{request()}</div>
          </div>
          <Show when={reply()}>
            <div>
              <div class="chat-ask-card__label">{t("chat.messages.reply")}</div>
              <MarkdownHtml class="chat-ask-card__reply" markdown={reply()} />
            </div>
          </Show>
          <Show when={failed() && error()}>
            <div class="chat-ask-card__error">{error()}</div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
