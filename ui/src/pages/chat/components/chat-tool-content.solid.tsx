import { createSignal, Show } from "solid-js";
import { isMarkdownBlockArtText } from "../../../components/markdown-text.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatToolLabelsEnglish } from "../../../i18n/locales/en-chat-tool-labels.ts";
import { t, registerEnglishCatalog } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatToolLabelsEnglish);

export function RawOutputToggle(props: {
  text: string;
  toggleRef?: (element: HTMLButtonElement) => void;
}) {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="chat-tool-card__raw">
      <button
        ref={(element) => props.toggleRef?.(element)}
        class="chat-inline-disclosure chat-tool-card__raw-toggle"
        type="button"
        aria-expanded={open() ? "true" : "false"}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{t("chat.toolCards.rawDetails")}</span>
        <span class="chat-inline-disclosure__chevron" aria-hidden="true">
          <Icon name="chevronDown" />
        </span>
      </button>
      <div class="chat-tool-card__raw-body" hidden={!open()}>
        <Show when={open()}>
          <ToolDataBlock text={props.text} />
        </Show>
      </div>
    </div>
  );
}

export function ToolDataBlock(props: { label?: string; text: string }) {
  return (
    <div class="chat-tool-card__block">
      <Show when={props.label}>
        <div class="chat-tool-card__block-header">
          <span class="chat-tool-card__block-icon">
            <Icon name="zap" />
          </span>
          <span class="chat-tool-card__block-label">{props.label}</span>
        </div>
      </Show>
      <pre class="chat-tool-card__block-content">
        <code class={{ "markdown-block-art": isMarkdownBlockArtText(props.text) }}>
          {props.text}
        </code>
      </pre>
    </div>
  );
}
