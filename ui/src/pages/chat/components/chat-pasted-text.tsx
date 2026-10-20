import type { JSX as SolidJSX } from "@solidjs/web";
import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { CompactAttachmentFile } from "./chat-attachment-file.tsx";
import { AttachmentPreviewChip } from "./chat-attachment-preview-chip.tsx";
import { readAttachmentText } from "./chat-attachment-text-reader.ts";
import type { AttachmentAdmission } from "./chat-message-attachment-admission-model.ts";

type PastedTextProps = {
  src?: string;
  sizeBytes?: number;
  scope: string;
  onOpen?: () => void;
  composerAction?: SolidJSX.Element;
  composerRemoveAction?: SolidJSX.Element;
  admission?: AttachmentAdmission;
};

export function ChatPastedText(props: PastedTextProps) {
  const [excerpt, setExcerpt] = createSignal("");
  const source = createMemo(
    () => ({ src: props.src, sizeBytes: props.sizeBytes, scope: props.scope }),
    {
      equals: (before, next) =>
        before.src === next.src &&
        before.sizeBytes === next.sizeBytes &&
        before.scope === next.scope,
    },
  );
  const readExcerpt = (value: ReturnType<typeof source>) => {
    onSettled(() => {
      setExcerpt("");
      const src = value.src;
      if (!src) {
        return undefined;
      }
      const controller = new AbortController();
      void (async () => {
        try {
          const text = await readAttachmentText(src, value.sizeBytes, controller.signal, "excerpt");
          if (controller.signal.aborted) {
            return;
          }
          const { derivePastedTextExcerpt } =
            await import("../../../lib/chat/pasted-text-excerpt.ts");
          if (!controller.signal.aborted) {
            setExcerpt(derivePastedTextExcerpt(text));
          }
        } catch {
          // The side panel owns loading errors, retry and the original-file download.
        }
      })();
      return () => controller.abort();
    });
    return null;
  };
  const label = () => excerpt() || t("chat.attachments.pastedText");
  return (
    <openclaw-chat-pasted-text style={{ display: "contents" }}>
      <Show when={source()} keyed>
        {readExcerpt}
      </Show>
      <Show
        when={props.composerAction}
        fallback={
          <AttachmentPreviewChip
            label={label()}
            icon={<Icon name="fileText" />}
            onClick={props.onOpen}
            onReveal={props.admission?.onAdmit}
            elementRef={props.admission?.observeElement}
          />
        }
      >
        <div class="chat-attachment-thumb chat-attachment-thumb--file chat-attachment-thumb--pasted-text">
          <CompactAttachmentFile
            attachment={{ id: props.scope, mimeType: "text/plain" }}
            label={label()}
            metadata={props.composerAction}
            onOpen={props.onOpen}
          />
          {props.composerRemoveAction}
        </div>
      </Show>
    </openclaw-chat-pasted-text>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-pasted-text": HTMLAttributes<HTMLElement>;
    }
  }
}
