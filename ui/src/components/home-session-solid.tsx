import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createMemo, createSignal, onCleanup, onSettled, Show } from "solid-js";
import { formatChatWorkContext } from "../../../src/chat/work-context.js";
import { useApplication } from "../lib/reactive/context.ts";
import { t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import type { ChatWorkContext } from "../pages/chat/chat-work-context.ts";
import "../pages/chat/chat-pane.ts";
import "../styles/chat.ts";
import "../styles/chat/composer.css";
import "../styles/chat/composer-status.css";
import { Icon } from "./solid/icon.tsx";

type Props = { sessionKey: string; agentId: string; workContext: ChatWorkContext };
export type OpenClawHomeSession = SolidBridgeElement<Props>;

/** The real Home conversation; its surrounding dock owns placement and focus. */
export const HomeSession = defineSolidBridge<Props>(
  "openclaw-home-session",
  (props, host) => {
    const app = useApplication();
    const [includeContext, setIncludeContext] = createSignal(true);
    const [selectionAvailable, setSelectionAvailable] = createSignal(false);
    const scope = createMemo(() =>
      JSON.stringify([
        app.gateway.connection.gatewayUrl,
        props.sessionKey,
        props.agentId,
        props.workContext.page,
        props.workContext.detail,
        props.workContext.sessionKey,
        props.workContext.sessionId,
        props.workContext.agentId,
        props.workContext.file,
      ]),
    );
    const [selection, setSelection] = createSignal(() => {
      scope();
      return "";
    });
    const context = createMemo(() => ({
      ...props.workContext,
      selection: selection() || undefined,
    }));
    const owner = () =>
      JSON.stringify([app.gateway.connection.gatewayUrl, props.agentId, props.sessionKey]);
    const updateSelectionAvailability = () => {
      const selected = window.getSelection();
      setSelectionAvailable(
        Boolean(
          selected &&
          !selected.isCollapsed &&
          selected.anchorNode &&
          !host.contains(selected.anchorNode),
        ),
      );
    };
    onSettled(() => {
      document.addEventListener("selectionchange", updateSelectionAvailability);
      updateSelectionAvailability();
    });
    onCleanup(() => document.removeEventListener("selectionchange", updateSelectionAvailability));
    const attachSelection = (event: MouseEvent) => {
      // Capture on the explicit action before focus clears the selection.
      event.preventDefault();
      const selected = window.getSelection();
      if (
        !selected ||
        selected.isCollapsed ||
        (selected.anchorNode && host.contains(selected.anchorNode))
      ) {
        return;
      }
      setSelection(truncateUtf16Safe(selected.toString(), 640));
      setIncludeContext(true);
    };
    return (
      <>
        <div class="assistant-panel-context">
          <Show
            when={includeContext()}
            fallback={
              <button type="button" class="btn btn--sm" onClick={() => setIncludeContext(true)}>
                {t("assistantPanel.includeContext")}
              </button>
            }
          >
            <details>
              <summary>
                {t("assistantPanel.context", { context: context().title || context().page })}
              </summary>
              <pre>{formatChatWorkContext(context())}</pre>
            </details>
            <button
              type="button"
              class="rail-header__action"
              aria-label={t("assistantPanel.removeContext")}
              onClick={() => setIncludeContext(false)}
            >
              <Icon name="x" />
            </button>
          </Show>
          <button
            type="button"
            class="rail-header__action"
            aria-label={t("assistantPanel.attachSelection")}
            disabled={!selectionAvailable()}
            title={t("assistantPanel.attachSelection")}
            onMouseDown={attachSelection}
            onClick={(event) => {
              if (event.detail === 0) {
                attachSelection(event);
              }
            }}
          >
            <Icon name="messageSquare" />
          </button>
          <Show when={selection()}>
            <button
              type="button"
              class="btn btn--sm"
              aria-label={t("assistantPanel.removeSelection")}
              onClick={() => setSelection("")}
            >
              {t("assistantPanel.selection")} <Icon name="x" />
            </button>
          </Show>
        </div>
        <Show when={owner()} keyed>
          {(identity) => (
            <openclaw-chat-pane
              prop:paneId={`home-dock:${identity}`}
              prop:presentationId={`home-dock:${identity}`}
              prop:sessionKey={props.sessionKey}
              prop:agentId={props.agentId}
              prop:inputRegion="dock"
              prop:active={true}
              prop:compact={true}
              prop:narrow={true}
              prop:workContext={includeContext() ? context() : undefined}
            />
          )}
        </Show>
      </>
    );
  },
  {
    properties: {
      sessionKey: { default: "", attribute: false },
      agentId: { default: "", attribute: false },
      workContext: { default: { page: "chat" }, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-home-session": OpenClawHomeSession;
  }
}
