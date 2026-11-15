import { createSignal, Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";

/**
 * The Gateway only supplies registry-hosted, content-addressed raster artwork.
 * Templates without usable artwork show the Templates Blobster in the container's color.
 */
export function TemplateArtwork(props: { src?: string }) {
  return (
    <Show when={props.src} keyed fallback={<Icon name="blobster" />}>
      {(src) => {
        const [failed, setFailed] = createSignal(false);
        return (
          <Show when={!failed()} fallback={<Icon name="blobster" />}>
            <img
              src={src}
              crossorigin="anonymous"
              alt=""
              loading="lazy"
              decoding="async"
              referrerpolicy="no-referrer"
              onError={() => setFailed(true)}
            />
          </Show>
        );
      }}
    </Show>
  );
}
