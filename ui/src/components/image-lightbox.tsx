import { Portal } from "@solidjs/web";
import { Errored, lazy, Loading } from "solid-js";
import { defineSolidBridge } from "../lib/solid-bridge.ts";
import { ImageLightboxHost } from "./image-lightbox-context.ts";
import type { ImageLightboxElement, ImageLightboxProps } from "./image-lightbox.types.ts";
import { LazyViewError } from "./solid/lazy-view-error.tsx";

const Content = lazy(() => import("./image-lightbox-content.tsx"), {
  export: "ImageLightboxContent",
});

export const ImageLightbox = defineSolidBridge<ImageLightboxProps>(
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

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-image-lightbox": ImageLightboxElement;
  }
}
