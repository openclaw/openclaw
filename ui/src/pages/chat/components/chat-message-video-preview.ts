import type { TemplateResult } from "lit";
import { createComponent } from "solid-js";
import { LitContent, solidContent } from "../../../lit/solid-content.tsx";
import { MessageVideoPreview } from "./chat-message-video-preview-solid.tsx";

type LegacyVideoPreviewProps = {
  key: string;
  src: string;
  label: string;
  onOpen: () => void;
  fallback: TemplateResult;
};
function LegacyVideoPreview(props: LegacyVideoPreviewProps) {
  return createComponent(MessageVideoPreview, {
    get key() {
      return props.key;
    },
    get src() {
      return props.src;
    },
    get label() {
      return props.label;
    },
    get onOpen() {
      return props.onOpen;
    },
    get fallback() {
      return createComponent(LitContent, {
        get value() {
          return props.fallback;
        },
      });
    },
  });
}
export function renderMessageVideoPreview(input: LegacyVideoPreviewProps) {
  return solidContent(LegacyVideoPreview, input);
}
