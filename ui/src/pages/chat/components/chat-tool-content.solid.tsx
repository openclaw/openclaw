import type { JSX } from "@solidjs/web";
import { createSignal, lazy, Loading, Show, omit } from "solid-js";
import { isMarkdownBlockArtText } from "../../../components/markdown-text.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import type { ToolCard, ToolCardOutcome } from "../../../lib/chat/chat-types.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ToolRenderOptions } from "./chat-tool-render-model.ts";

const ExpandedContent = lazy(() => import("./chat-tool-expanded.solid.tsx"), {
  export: "ExpandedToolCardContent",
});

export function ExpandedToolCardContent(props: { card: ToolCard; options: ToolRenderOptions }) {
  return (
    <Loading>
      <ExpandedContent {...props} />
    </Loading>
  );
}

export function RawOutputToggle(props: { text: string }) {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="chat-tool-card__raw">
      <button
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
        <ToolDataBlock text={props.text} />
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

export function ToolOutcome(props: { outcome: ToolCardOutcome; exitCode?: number }) {
  const label = () =>
    props.outcome === "failed" && props.exitCode !== undefined && props.exitCode !== 0
      ? t("chat.toolCards.exitCode", { code: String(props.exitCode) })
      : t(
          `chat.toolCards.${props.outcome === "succeeded" ? "completed" : props.outcome === "unknown" ? "outcomeUnknown" : props.outcome}`,
        );
  return <div class="chat-tool-card__outcome">{label()}</div>;
}

export function ChatToolContent(
  props: {
    card: ToolCard;
    options: ToolRenderOptions;
  } & JSX.HTMLAttributes<HTMLElement>,
) {
  const attributes = omit(props, "card", "options", "children");
  return (
    <openclaw-chat-tool-content {...attributes}>
      <ExpandedToolCardContent card={props.card} options={props.options} />
    </openclaw-chat-tool-content>
  );
}

export function ChatToolRawOutput(props: { text: string } & JSX.HTMLAttributes<HTMLElement>) {
  const attributes = omit(props, "text", "children");
  return (
    <openclaw-chat-tool-raw {...attributes}>
      <RawOutputToggle text={props.text} />
    </openclaw-chat-tool-raw>
  );
}

export function ChatToolOutcome(
  props: {
    outcome: ToolCardOutcome;
    exitCode?: number;
  } & JSX.HTMLAttributes<HTMLElement>,
) {
  const attributes = omit(props, "outcome", "exitCode", "children");
  return (
    <openclaw-chat-tool-outcome {...attributes}>
      <ToolOutcome outcome={props.outcome} exitCode={props.exitCode} />
    </openclaw-chat-tool-outcome>
  );
}
