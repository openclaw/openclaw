import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createMemo, Show } from "solid-js";
import { registerChatToolContentEnglish } from "../../../i18n/locales/en-chat-tool-content.ts";
import { resolveToolCallInput } from "../../../lib/chat/tool-call-input.ts";
import type { ToolCardOutput } from "../../../lib/chat/tool-cards.ts";
import {
  readToolOutputText,
  isLegacyToolOutputUnavailable,
} from "../../../lib/chat/tool-output-text.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { ToolCardProps } from "./chat-tool-card-types.ts";

registerEnglishCatalog(registerChatToolContentEnglish);

/** Optional preview presentation reads the same invocation output as the command row. */
export function InlineToolPreview(props: ToolCardProps & { output?: ToolCardOutput }) {
  const previewKind = createMemo(
    () => {
      const current = props.card;
      return resolveToolCallInput(current.name, asNullableRecord(current.args)).kind;
    },
    { lazy: true },
  );
  const preview = createMemo(() => {
    const kind = previewKind();
    if (kind !== "command" && kind !== "read" && kind !== "search") {
      return undefined;
    }
    const current = props.output
      ? { ...props.card, outputText: props.output.outputText, liveOutput: props.output.liveOutput }
      : props.card;
    const liveOutput =
      current.live && !current.completed && props.options.runActive
        ? current.liveOutput
        : undefined;
    // Keep compact output literal; rich JSON formatting belongs to expanded output.
    const output = (liveOutput?.text ?? readToolOutputText(current))?.trimEnd();
    if (!output) {
      return undefined;
    }
    let start = output.length;
    for (let line = 0; line < 3; line++) {
      start = start > 0 ? output.lastIndexOf("\n", start - 1) : -1;
      if (start < 0) {
        break;
      }
    }
    const text = sliceUtf16Safe(output, Math.max(start + 1, output.length - 600));
    return {
      text,
      rolling: liveOutput !== undefined,
      more: text.length < output.length || (liveOutput?.omittedChars ?? 0) > 0,
      truncated:
        current.outputTruncated ||
        current.catalogTruncated ||
        isLegacyToolOutputUnavailable(current),
    };
  });
  return (
    <Show when={preview()}>
      {(value) => (
        <div class="chat-command-trail__preview">
          <div class="chat-command-trail__preview-output">
            <pre class="chat-tool-output__text">{value().text}</pre>
          </div>
          <Show when={value().more}>
            <button
              type="button"
              class="chat-command-trail__more"
              onClick={() => props.options.onToggleExpanded(props.card.id)}
            >
              {t(value().rolling ? "chat.toolCards.previewCaptured" : "chat.toolCards.previewMore")}
            </button>
          </Show>
          <Show when={value().truncated}>
            <span>{t("chat.toolCards.previewTruncated")}</span>
          </Show>
        </div>
      )}
    </Show>
  );
}
