import { Errored, lazy, Loading, Show } from "solid-js";
import { ImageLightboxError } from "./image-lightbox-error.tsx";
import type { ImageLightboxItem, ImageLightboxProps } from "./image-lightbox.types.ts";

// The native bridge and its renderer arrive in the existing content request.
const View = lazy(() => import("./image-lightbox-content.tsx"), {
  export: "ImageLightboxItemView",
});

export function ImageLightboxItemView(props: {
  item: ImageLightboxItem | null | undefined;
  onClose: () => void;
  description?: string;
  onUseImage?: ImageLightboxProps["onUseImage"];
}) {
  return (
    <Show when={props.item}>
      <Errored
        fallback={(error, reset) => (
          <ImageLightboxError
            error={error()}
            title={props.item?.title}
            onRetry={() => reset()}
            onClose={() => props.onClose()}
          />
        )}
      >
        <Loading>
          <View {...props} />
        </Loading>
      </Errored>
    </Show>
  );
}
