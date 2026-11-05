import type { JSX as SolidJSX } from "@solidjs/web";
import { createMemo, onCleanup, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { t, registerEnglishCatalog } from "../../../lib/reactive/i18n.ts";
import { CompactAttachmentFile } from "./chat-attachment-file.tsx";
import { AttachmentPreviewChip } from "./chat-attachment-preview-chip.tsx";
import { readAttachmentText } from "./chat-attachment-text-reader.ts";
import type { AttachmentAdmission } from "./chat-message-attachment-admission-model.ts";

registerEnglishCatalog(registerChatComposerEnglish);

export function ChatPastedText(props: {
  src?: string;
  sizeBytes?: number;
  scope: string;
  onOpen?: () => void;
  composerAction?: SolidJSX.Element;
  composerRemoveAction?: SolidJSX.Element;
  admission?: AttachmentAdmission;
}) {
  const source = createMemo(
    () => ({ src: props.src, sizeBytes: props.sizeBytes, scope: props.scope }),
    {
      equals: (before, next) =>
        before.src === next.src &&
        before.sizeBytes === next.sizeBytes &&
        before.scope === next.scope,
    },
  );
  const excerpt = createMemo(() => {
    const { src, sizeBytes } = source();
    if (!src) {
      return () => "";
    }
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    // Each source starts with a generic label without replacing the interactive chip.
    return createMemo(
      async () => {
        try {
          const text = await readAttachmentText(src, sizeBytes, controller.signal, "excerpt");
          if (controller.signal.aborted) {
            return "";
          }
          const { derivePastedTextExcerpt } =
            await import("../../../lib/chat/pasted-text-excerpt.ts");
          return controller.signal.aborted ? "" : derivePastedTextExcerpt(text);
        } catch {
          // The side panel owns loading errors, retry and the original-file download.
          return "";
        }
      },
      { loadingValue: "" },
    );
  });
  const label = () => excerpt()() || t("chat.attachments.pastedText");
  return (
    <openclaw-chat-pasted-text style={{ display: "contents" }}>
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
