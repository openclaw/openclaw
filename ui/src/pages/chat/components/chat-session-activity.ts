import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../../components/icons.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { rawMessageTimestamp } from "../chat-thread-items.ts";
import { renderForwardedAttribution } from "./chat-forwarded-attribution.ts";
import type { RenderMessageGroupOptions } from "./chat-message-group-options.ts";
import { renderChatTimestamp } from "./chat-message-timestamp.ts";
import "./chat-session-activity.css";

export function renderInterSessionActivity(
  group: MessageGroup,
  opts: RenderMessageGroupOptions,
  renderEntry: (
    item: MessageGroup["messages"][number],
    index: number,
  ) => { content: unknown; actions: unknown },
) {
  const disclosureId = "inter-session:" + group.key;
  const expanded =
    Boolean(opts.searchResult) || (opts.isToolMessageExpanded?.(disclosureId) ?? false);
  const count = group.messages.reduce((total, message) => total + (message.duplicateCount ?? 1), 0);
  return html`
    <div
      class="chat-group tool chat-group--turn-block"
      data-chat-row-key=${group.key}
      data-file-session-key=${group.senderSession?.sessionKey ?? nothing}
    >
      <div class="chat-group-messages">
        <details
          class="chat-session-activity"
          .open=${expanded}
          @toggle=${(event: Event) => {
            if (!(event.currentTarget instanceof HTMLDetailsElement) || opts.searchResult) {
              return;
            }
            const open = event.currentTarget.open;
            if (open !== (opts.isToolMessageExpanded?.(disclosureId) ?? false)) {
              opts.onToggleToolMessageExpanded?.(disclosureId, !open);
            }
          }}
        >
          <summary
            class="chat-inline-disclosure chat-session-activity__summary"
            aria-disabled=${opts.searchResult ? "true" : nothing}
            tabindex=${opts.searchResult ? "-1" : nothing}
            @click=${(event: MouseEvent) => {
              const target = event.target;
              if (
                opts.searchResult &&
                !(target instanceof Element && target.closest("a.markdown-session-link"))
              ) {
                event.preventDefault();
              }
            }}
          >
            ${
              expanded
                ? renderForwardedAttribution(group, { ...opts, showAvatar: false })
                : renderForwardedAttribution(group, {
                    ...opts,
                    updateCount: count,
                    linkSource: false,
                  })
            }
            ${opts.searchResult ? nothing : html`<span class="chat-session-activity__chevron" aria-hidden="true">${icons.chevronRight}</span>`}
          </summary>
          <div class="chat-session-activity__body">
            ${
              expanded || !opts.onToggleToolMessageExpanded
                ? repeat(
                    group.messages,
                    (item) => item.key,
                    (item, index) => {
                      const rendered = renderEntry(item, index);
                      return html`<div class="chat-session-activity__message">
                        ${rendered.content}
                        <div class="chat-session-activity__meta">
                          ${renderChatTimestamp(rawMessageTimestamp(item.message) ?? group.timestamp)}
                          <div
                            class="chat-group-footer-actions"
                            data-message-actions-for=${item.key}
                          >
                            ${rendered.actions}
                          </div>
                        </div>
                      </div>`;
                    },
                  )
                : nothing
            }
          </div>
        </details>
      </div>
    </div>
  `;
}
