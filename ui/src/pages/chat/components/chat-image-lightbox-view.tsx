import { Show } from "solid-js";
import { ImageLightbox } from "../../../components/image-lightbox.tsx";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";

export function ChatImageLightbox(props: {
  item: ImageLightboxItem | null | undefined;
  onClose: () => void;
}) {
  return (
    <Show when={props.item}>
      {(item) => (
        <ImageLightbox
          mediaKind={item().kind ?? "image"}
          gallery={item().gallery}
          connectVideo={item().connectVideo}
          loadFullResolution={item().loadFullResolution}
          src={item().src}
          originalSrc={item().originalSrc ?? ""}
          imageTitle={item().title}
          imageWidth={item().width}
          imageHeight={item().height}
          onImage-lightbox-close={props.onClose}
        />
      )}
    </Show>
  );
}
