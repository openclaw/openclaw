import type { TemplateResult } from "lit";
import { createComponent, createMemo } from "solid-js";
import { LitContent, solidContent } from "../../../lit/solid-content.tsx";
import { MessageImages } from "./chat-message-images-solid.tsx";
import type { ImageBlock, ImageRenderOptions } from "./chat-message-media.ts";

type LegacyMessageImagesProps = {
  images: ImageBlock[];
  options?: ImageRenderOptions;
  previews: TemplateResult[];
};
function LegacyMessageImages(props: LegacyMessageImagesProps) {
  const previewCount = createMemo(() => props.previews.length);
  const previews = createMemo(() =>
    Array.from({ length: previewCount() }, (_, index) =>
      createComponent(LitContent, {
        get value() {
          return props.previews[index];
        },
      }),
    ),
  );
  return createComponent(MessageImages, {
    get images() {
      return props.images;
    },
    get options() {
      return props.options;
    },
    get previews() {
      return previews();
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
