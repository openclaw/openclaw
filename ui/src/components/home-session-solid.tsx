import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { formatChatWorkContext } from "../../../src/chat/work-context.js";
import { useApplication } from "../lib/reactive/context.ts";
import { t } from "../lib/reactive/i18n.ts";
import { listen } from "../lib/reactive/listener.ts";
import type { ChatWorkContext } from "../pages/chat/chat-work-context.ts";
import "../pages/chat/chat-pane.tsx";
import "../styles/chat.ts";
import "../styles/chat/composer.css";
import "../styles/chat/composer-status.css";
import { Icon } from "./solid/icon.tsx";

type Props = { sessionKey: string; agentId: string; workContext: ChatWorkContext };

/** The real Home conversation; its surrounding dock owns placement and focus. */
export function HomeSession(input: Partial<Props>) {
  const sessionKey = () => input.sessionKey ?? "";
  const agentId = () => input.agentId ?? "";
  const defaultWorkContext: ChatWorkContext = { page: "chat" };
  const workContext = () => input.workContext ?? defaultWorkContext;
  let host!: HTMLElement;
  const app = useApplication();
  const [includeContext, setIncludeContext] = createSignal(true);
  const [selectionAvailable, setSelectionAvailable] = createSignal(false);
  const scope = createMemo(() =>
    JSON.stringify([
      app.gateway.connection.gatewayUrl,
      sessionKey(),
      agentId(),
      workContext().page,
      workContext().detail,
      workContext().sessionKey,
      workContext().sessionId,
      workContext().agentId,
      workContext().file,
    ]),
  );
  const [selection, setSelection] = createSignal(() => {
    scope();
    return "";
  });
  const context = createMemo(() => ({
    ...workContext(),
    selection: selection() || undefined,
  }));
  const owner = () => JSON.stringify([app.gateway.connection.gatewayUrl, agentId(), sessionKey()]);
  const externalSelection = () => {
    const selected = window.getSelection();
    return selected && !selected.isCollapsed && !host.contains(selected.anchorNode)
      ? selected
      : null;
  };
  const updateSelectionAvailability = () => setSelectionAvailable(Boolean(externalSelection()));
  onSettled(() => {
    const stop = listen(document, "selectionchange", updateSelectionAvailability);
    updateSelectionAvailability();
    return stop;
  });
  const attachSelection = (event: MouseEvent) => {
    // Capture on the explicit action before focus clears the selection.
    event.preventDefault();
    const selected = externalSelection();
    if (!selected) {
      return;
    }
    setSelection(truncateUtf16Safe(selected.toString(), 640));
    setIncludeContext(true);
  };
  return (
    <openclaw-home-session ref={(element) => (host = element)}>
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
            prop:sessionKey={sessionKey()}
            prop:agentId={agentId()}
            prop:inputRegion="dock"
            prop:active={true}
            prop:compact={true}
            prop:narrow={true}
            prop:workContext={includeContext() ? context() : undefined}
          />
        )}
      </Show>
    </openclaw-home-session>
  );
}
