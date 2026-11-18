import type { JSX } from "@solidjs/web";
import { For, Show, type Accessor } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { resolveIdentityHue } from "../../../lib/identity-avatar.ts";
import { participantPalette } from "../../../lib/reactive/participant-palette.ts";
import { ForwardedAvatar } from "../chat-avatar.ts";
import { rawMessageTimestamp } from "../chat-thread-items.ts";
import { isInterSessionMessage } from "../chat-turn-boundary.ts";
import { ForwardedAttribution } from "./chat-forwarded-attribution.tsx";
import type { RenderMessageGroupOptions } from "./chat-message-group-options.ts";
import { ChatTimestamp } from "./chat-message-timestamp-view.tsx";
import "./chat-session-activity.css";
import "./chat-inter-session.css";

function ChatInterSessionMessages(props: SessionActivityProps) {
  return (
    <div
      class="chat-group assistant chat-group--forwarded chat-group--sender-tint chat-group--inter-session"
      style={
        props.group.senderSession?.sessionKey
          ? participantPalette
              .read()
              ?.style(resolveIdentityHue({ id: props.group.senderSession.sessionKey }))
          : undefined
      }
      data-chat-row-key={props.group.key}
      data-file-session-key={props.group.senderSession?.sessionKey}
    >
      <ForwardedAvatar
        agentId={props.group.senderSession?.agentId ?? props.options.agentId}
        options={props.options}
      />
      <div class="chat-group-messages">
        <ForwardedAttribution
          group={props.group}
          options={{ ...props.options, sourceOnly: true }}
        />
        <For each={props.group.messages} keyed={(item) => item.key}>
          {(item, index) => {
            const entry = props.renderEntry(item, index);
            return (
              <div class="chat-inter-session-message">
                {entry.content}
                <div class="chat-session-activity__meta">
                  <ChatTimestamp
                    timestamp={rawMessageTimestamp(item().message) ?? props.group.timestamp}
                  />
                  <div
                    ref={(element) => entry.actionsRef?.(element)}
                    class="chat-group-footer-actions"
                    data-message-actions-for={item().key}
                  >
                    {entry.actions}
                  </div>
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}

type SessionActivityProps = {
  group: MessageGroup;
  options: RenderMessageGroupOptions;
  renderEntry: (
    item: Accessor<MessageGroup["messages"][number]>,
    index: Accessor<number>,
  ) => {
    content: JSX.Element;
    actions: JSX.Element;
    actionsRef?: (element: HTMLDivElement) => void;
  };
};

function AutomationSessionActivity(props: SessionActivityProps) {
  const disclosureId = () => "session-activity:" + props.group.key;
  const expanded = () =>
    Boolean(props.options.searchResult) ||
    (props.options.isToolMessageExpanded?.(disclosureId()) ?? false);
  return (
    <div
      class="chat-group tool chat-group--turn-block"
      style={
        props.group.senderSession?.sessionKey
          ? participantPalette
              .read()
              ?.style(resolveIdentityHue({ id: props.group.senderSession.sessionKey }))
          : undefined
      }
      data-chat-row-key={props.group.key}
      data-file-session-key={props.group.senderSession?.sessionKey}
    >
      <div class="chat-group-messages">
        <details
          class="chat-session-activity"
          prop:open={expanded()}
          onToggle={(event) => {
            if (props.options.searchResult) {
              return;
            }
            const open = event.currentTarget.open;
            if (open !== (props.options.isToolMessageExpanded?.(disclosureId()) ?? false)) {
              props.options.onToggleToolMessageExpanded?.(disclosureId(), !open);
            }
          }}
        >
          <summary
            class="chat-inline-disclosure chat-session-activity__summary"
            aria-disabled={props.options.searchResult ? "true" : undefined}
            tabindex={props.options.searchResult ? -1 : undefined}
            onClick={(event) => {
              if (
                props.options.searchResult &&
                !(
                  event.target instanceof Element && event.target.closest("a.markdown-session-link")
                )
              ) {
                event.preventDefault();
              }
            }}
          >
            {/* One summary for both states, so only the chevron moves on toggle. The
                source link's click is canceled by the transcript's navigation
                handler, which also cancels the summary's toggle activation. */}
            <ForwardedAttribution
              group={props.group}
              options={{
                ...props.options,
                updateCount: props.group.messages.length,
              }}
            />
            <Show when={!props.options.searchResult}>
              <span class="chat-session-activity__chevron" aria-hidden="true">
                <Icon name="chevronRight" />
              </span>
            </Show>
          </summary>
          <div class="chat-session-activity__body">
            <Show when={expanded() || !props.options.onToggleToolMessageExpanded}>
              <For each={props.group.messages} keyed={(item) => item.key}>
                {(item, index) => {
                  const entry = props.renderEntry(item, index);
                  return (
                    <div class="chat-session-activity__message">
                      {entry.content}
                      <div class="chat-session-activity__meta">
                        <ChatTimestamp
                          timestamp={rawMessageTimestamp(item().message) ?? props.group.timestamp}
                        />
                        <div
                          ref={(element) => entry.actionsRef?.(element)}
                          class="chat-group-footer-actions"
                          data-message-actions-for={item().key}
                        >
                          {entry.actions}
                        </div>
                      </div>
                    </div>
                  );
                }}
              </For>
            </Show>
          </div>
        </details>
      </div>
    </div>
  );
}

export function ChatSessionActivity(props: SessionActivityProps) {
  return (
    <Show
      when={isInterSessionMessage(props.group.messages[0]?.message)}
      fallback={<AutomationSessionActivity {...props} />}
    >
      <ChatInterSessionMessages {...props} />
    </Show>
  );
}
