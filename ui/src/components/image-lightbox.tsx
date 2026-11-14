import { Errored, lazy, Loading, Show } from "solid-js";
import { defineSolidBridge } from "../lib/solid-bridge.ts";
import { ImageLightboxHost } from "./image-lightbox-context.ts";
import { ImageLightboxError } from "./image-lightbox-error.tsx";
import type {
  ImageLightboxElement,
  ImageLightboxItem,
  ImageLightboxProps,
} from "./image-lightbox.types.ts";

const Content = lazy(() => import("./image-lightbox-content.tsx"), {
  export: "ImageLightboxContent",
});

const nonAttributeProperty = { default: undefined, attribute: false } as const;
const textProperty = { default: "" };
const nonAttributeTextProperty = { default: "", attribute: false } as const;

const ImageLightbox = defineSolidBridge<ImageLightboxProps>(
  "openclaw-image-lightbox",
  (props, host) => (
    <ImageLightboxHost value={host}>
      <Errored
        fallback={(error, reset) => (
          <ImageLightboxError
            error={error()}
            title={props.imageTitle}
            onRetry={() => reset()}
            onClose={() =>
              host.dispatchEvent(
                new CustomEvent("image-lightbox-close", { bubbles: true, composed: true }),
              )
            }
          />
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
      onUseImage: nonAttributeProperty,
      connectVideo: nonAttributeProperty,
      gallery: nonAttributeProperty,
      loadDisplayImage: nonAttributeProperty,
      readOriginalBlob: nonAttributeProperty,
      mediaKind: { default: "image" },
      src: textProperty,
      originalSrc: textProperty,
      imageTitle: nonAttributeTextProperty,
      imageDescription: nonAttributeTextProperty,
      imageWidth: nonAttributeProperty,
      imageHeight: nonAttributeProperty,
    },
  },
);

export function ImageLightboxItemView(props: {
  item: ImageLightboxItem | null | undefined;
  onClose: () => void;
  description?: string;
  onUseImage?: ImageLightboxProps["onUseImage"];
}) {
  return (
    <Show when={props.item}>
      {(item) => (
        <ImageLightbox
          onUseImage={props.onUseImage}
          mediaKind={item().kind}
          gallery={item().gallery}
          connectVideo={item().connectVideo}
          loadDisplayImage={item().loadDisplayImage}
          readOriginalBlob={item().readOriginalBlob}
          src={item().src}
          originalSrc={item().originalSrc}
          imageTitle={item().title}
          imageDescription={props.description}
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
