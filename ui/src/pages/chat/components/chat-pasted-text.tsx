import type { JSX as SolidJSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
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

function PastedText(props: PastedTextProps) {
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
  createEffect(source, (value) => {
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
  const label = () => excerpt() || t("chat.attachments.pastedText");
  return (
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
  );
}

export const ChatPastedText = defineSolidBridge<PastedTextProps>(
  "openclaw-chat-pasted-text",
  (props, host) => {
    host.style.display = "contents";
    return <PastedText {...props} />;
  },
  {
    properties: {
      src: { default: undefined },
      sizeBytes: { default: undefined, attribute: false },
      scope: { default: "", attribute: false },
      onOpen: { default: undefined, attribute: false },
      composerAction: { default: undefined, attribute: false },
      composerRemoveAction: { default: undefined, attribute: false },
      admission: { default: undefined, attribute: false },
    },
  },
);

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-pasted-text": HTMLAttributes<SolidBridgeElement<PastedTextProps>> & {
        "prop:src"?: PastedTextProps["src"];
        "prop:sizeBytes"?: PastedTextProps["sizeBytes"];
        "prop:scope"?: PastedTextProps["scope"];
        "prop:onOpen"?: PastedTextProps["onOpen"];
        "prop:composerAction"?: PastedTextProps["composerAction"];
        "prop:composerRemoveAction"?: PastedTextProps["composerRemoveAction"];
        "prop:admission"?: PastedTextProps["admission"];
      };
    }
  }
}
