import { solidContent } from "../../../lit/solid-content.tsx";
import { MessageImages } from "./chat-message-images-solid.tsx";
import type { ImageBlock, ImageRenderOptions } from "./chat-message-media.ts";

export function renderMessageImages(images: ImageBlock[], options?: ImageRenderOptions) {
  return solidContent(MessageImages, { images, options });
}
