import { createSignal, Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";

/** The Gateway only supplies registry-hosted, content-addressed raster artwork. */
export function TemplateArtwork(props: { src?: string }) {
  return (
    <Show when={props.src} keyed fallback={<Icon name="box" />}>
      {(src) => {
        const [failed, setFailed] = createSignal(false);
        return (
          <Show when={!failed()} fallback={<Icon name="box" />}>
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
