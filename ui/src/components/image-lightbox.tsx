import { Portal } from "@solidjs/web";
import { Errored, lazy, Loading, Show } from "solid-js";
import { defineSolidBridge } from "../lib/solid-bridge.ts";
import { ImageLightboxHost } from "./image-lightbox-context.ts";
import type {
  ImageLightboxElement,
  ImageLightboxItem,
  ImageLightboxProps,
} from "./image-lightbox.types.ts";
import { LazyViewError } from "./solid/lazy-view-error.tsx";

const Content = lazy(() => import("./image-lightbox-content.tsx"), {
  export: "ImageLightboxContent",
});

const ImageLightbox = defineSolidBridge<ImageLightboxProps>(
  "openclaw-image-lightbox",
  (props, host) => (
    <ImageLightboxHost value={host}>
      <Errored
        fallback={(error, reset) => (
          <Portal>
            <div
              style={{
                position: "fixed",
                right: "1rem",
                bottom: "1rem",
                width: "min(420px, calc(100vw - 2rem))",
                "z-index": "var(--z-toast)",
              }}
            >
              <LazyViewError
                error={error()}
                subtitle={props.imageTitle}
                onRetry={() => reset()}
                onClose={() =>
                  host.dispatchEvent(
                    new CustomEvent("image-lightbox-close", { bubbles: true, composed: true }),
                  )
                }
                inline
              />
            </div>
          </Portal>
        )}
      >
        <Loading>
          <Content {...props} />
        </Loading>
      </Errored>
    </ImageLightboxHost>
  ),
  {
    properties: {
      connectVideo: { default: undefined, attribute: false },
      gallery: { default: undefined, attribute: false },
      loadDisplayImage: { default: undefined, attribute: false },
      readOriginalBlob: { default: undefined, attribute: false },
      mediaKind: { default: "image" },
      src: { default: "" },
      originalSrc: { default: "" },
      imageTitle: { default: "", attribute: false },
      imageDescription: { default: "", attribute: false },
      imageWidth: { default: undefined, attribute: false },
      imageHeight: { default: undefined, attribute: false },
    },
  },
);

export function ImageLightboxItemView(props: {
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
          loadDisplayImage={item().loadDisplayImage}
          readOriginalBlob={item().readOriginalBlob}
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

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-image-lightbox": ImageLightboxElement;
  }
}
