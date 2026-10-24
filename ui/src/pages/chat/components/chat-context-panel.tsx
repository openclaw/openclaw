import { Show, createMemo } from "solid-js";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { createParkedProjection } from "../../../lib/reactive/parked-projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import { getContextNoticeViewModel } from "./chat-composer-context.tsx";
import {
  ChatDetailsContextContent,
  ChatDetailsContextSummary,
  type ChatDetailsContextContentProps,
} from "./chat-details-context.tsx";

export type ChatContextPanelProps = {
  details?: ChatDetailsContextContentProps["details"];
  presented: boolean;
  onScrollPortRef?: (element: HTMLElement) => void | (() => void);
};
export type ChatContextPanel = SolidBridgeElement<ChatContextPanelProps>;

export const ChatContextPanel = defineSolidBridge<ChatContextPanelProps>(
  "openclaw-chat-context-panel",
  (props) => {
    const details = createParkedProjection(
      () => (props.presented ? props.details : undefined),
      () => props.presented,
    );
    const identity = createMemo(() => {
      const session = details()?.selectedSession;
      return session && JSON.stringify([details()?.currentAgentId, session.key, session.sessionId]);
    });
    const usage = createMemo(() => getContextNoticeViewModel(details()?.selectedSession));
    return (
      <div class="chat-context-panel" ref={elementRef(props.onScrollPortRef)}>
        <Show
          when={usage()}
          fallback={<p class="chat-context__note">{t("chat.sidePanel.contextEmpty")}</p>}
        >
          <Show when={identity()} keyed>
            {(_sessionIdentity) => (
              <Show when={details()}>
                {(currentDetails) => (
                  <>
                    <div class="chat-context-panel__summary">
                      <h2>{t("chat.sessionDetails.context")}</h2>
                      <ChatDetailsContextSummary details={currentDetails()} />
                    </div>
                    <ChatDetailsContextContent
                      details={currentDetails()}
                      presented={props.presented}
                      expanded
                    />
                  </>
                )}
              </Show>
            )}
          </Show>
        </Show>
      </div>
    );
  },
  {
    properties: {
      details: { default: undefined, attribute: false },
      presented: { default: false },
      onScrollPortRef: { default: undefined, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-context-panel": ChatContextPanel;
  }
}
