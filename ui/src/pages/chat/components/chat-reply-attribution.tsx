import { Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { ChatAuthorAvatar } from "./chat-author-avatar.ts";
import type { ReplyLine } from "./chat-reply-attribution.ts";
import { ReplyConnector, type ReplyConnectorElements } from "./chat-reply-connector.ts";

type ReplyLineActions = {
  onOpenReply?: (id: string) => void;
  replyNavigationId?: string | null;
};

type ReplyLineProps = {
  line: ReplyLine;
  actions: ReplyLineActions;
  inline?: boolean;
  elements?: ReplyConnectorElements;
};

/** Inline lines live inside the bubble; other lines sit beside its avatar. */
export function ReplyLineView(props: ReplyLineProps) {
  const named = () => props.line.state === "named";
  const name = () => props.line.name ?? "";
  const loading = () =>
    Boolean(props.line.openId) && props.actions.replyNavigationId === props.line.openId;
  const person = () => (
    <>
      <Show when={named()}>
        <ChatAuthorAvatar sender={props.line.sender} agentAvatar={props.line.agentAvatar} />
      </Show>
      <span class="chat-reply-attribution__name" title={name()}>
        {name()}
      </span>
    </>
  );
  return (
    <Show when={props.line.state !== "hidden"}>
      <div
        ref={(element) => {
          if (props.elements) {
            props.elements.row = element;
          }
        }}
        class={[
          "chat-reply-attribution",
          `chat-reply-attribution--${props.inline ? "inline" : "reply"}`,
          { "chat-reply-attribution--pending": props.line.state === "reserved" },
        ]}
        aria-hidden={props.line.state === "reserved" ? "true" : undefined}
      >
        <span
          ref={(element) => {
            if (props.elements) {
              props.elements.label = element;
            }
          }}
          class="chat-reply-attribution__label"
        >
          <Show when={!props.inline}>
            <span class="chat-reply-attribution__mobile-icon" aria-hidden="true">
              <Icon name="cornerUpLeft" />
            </span>
          </Show>
          {t("chat.messages.replyingToLabel")}
        </span>{" "}
        <Show when={props.line.state !== "reserved"}>
          <Show
            when={named() && props.line.openId && props.actions.onOpenReply}
            fallback={
              <Show when={name()}>
                <span class="chat-reply-attribution__person">{person()}</span>
              </Show>
            }
          >
            <button
              class="chat-reply-attribution__person chat-reply-attribution__target"
              type="button"
              aria-label={t("chat.messages.replyingTo", { name: name() })}
              disabled={loading()}
              aria-busy={loading() ? "true" : "false"}
              onClick={() => {
                if (props.line.openId) {
                  props.actions.onOpenReply?.(props.line.openId);
                }
              }}
            >
              {person()}
            </button>
          </Show>{" "}
          <Show when={!named()}>
            <span class="chat-reply-attribution__unavailable">
              {t("chat.messages.replyOriginalUnavailable")}
            </span>
          </Show>
        </Show>
      </div>
    </Show>
  );
}

export function ReplyLineConnector(props: {
  line: ReplyLine;
  avatar: boolean | null | undefined;
  elements: ReplyConnectorElements;
}) {
  return (
    <Show
      when={props.avatar && (props.line.state === "named" || props.line.state === "unavailable")}
    >
      <ReplyConnector elements={props.elements} />
    </Show>
  );
}
