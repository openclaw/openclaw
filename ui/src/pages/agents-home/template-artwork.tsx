import type { JSX } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";

/**
 * The Gateway only supplies registry-hosted, content-addressed raster artwork.
 * Templates without usable artwork show the Templates Blobster in the container's color.
 */
export function TemplateArtwork(props: { src?: string; placeholder?: JSX.Element }) {
  return (
    <Show when={props.src} keyed fallback={<Icon name="blobster" />}>
      {(src) => {
        const [state, setState] = createSignal<"pending" | "loaded" | "failed">("pending");
        return (
          <Show when={state() !== "failed"} fallback={<Icon name="blobster" />}>
            <Show when={state() === "pending"}>{props.placeholder}</Show>
            <img
              src={src}
              crossorigin="anonymous"
              alt=""
              loading="lazy"
              decoding="async"
              referrerpolicy="no-referrer"
              onLoad={() => setState("loaded")}
              onError={() => setState("failed")}
            />
          </Show>
        );
      }}
    </Show>
  );
}
