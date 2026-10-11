import type { TemplateResult } from "lit";
import { createComponent } from "solid-js";
import { LitContent, solidContent } from "../../../lit/solid-content.tsx";
import { MessageImages } from "./chat-message-images-solid.tsx";
import type { ImageBlock, ImageRenderOptions } from "./chat-message-media.ts";

type LegacyMessageImagesProps = {
  images: ImageBlock[];
  options?: ImageRenderOptions;
  previews: TemplateResult[];
};
function LegacyMessageImages(props: LegacyMessageImagesProps) {
  return createComponent(MessageImages, {
    get images() {
      return props.images;
    },
    get options() {
      return props.options;
    },
    get previews() {
      return props.previews.map((value) => createComponent(LitContent, { value }));
    },
  });
}
export function renderMessageImages(
  images: ImageBlock[],
  options?: ImageRenderOptions,
  previews: TemplateResult[] = [],
) {
  return solidContent(LegacyMessageImages, { images, options, previews });
}
