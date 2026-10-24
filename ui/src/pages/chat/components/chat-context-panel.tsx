import { Show, createMemo } from "solid-js";
import { t } from "../../../lib/reactive/i18n.ts";
import { createParkedProjection } from "../../../lib/reactive/parked-projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import { ChatContextPage, ContextEmpty, type ContextPageDetails } from "./chat-context-page.tsx";

export type ChatContextPanelProps = {
  details?: ContextPageDetails;
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
    return (
      <div class="chat-context-panel">
        <Show
          when={identity()}
          keyed
          fallback={<ContextEmpty message={t("chat.sidePanel.contextEmpty")} />}
        >
          {(_identity) => (
            <Show when={details()}>
              {(current) => (
                <ChatContextPage
                  details={current()}
                  presented={props.presented}
                  onScrollPortRef={props.onScrollPortRef}
                />
              )}
            </Show>
          )}
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
