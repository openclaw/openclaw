import { createSignal, Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";

const ARTWORK_REVEAL_BUDGET_MS = 500;

/**
 * Fetch and decode artwork before its cards render, so icons paint with the card
 * text instead of arriving a few hundred milliseconds later. The wait is bounded:
 * slow or failed artwork reveals the cards and loads in place as before.
 */
export async function preloadTemplateArtwork(urls: readonly string[]): Promise<void> {
  if (urls.length === 0) {
    return;
  }
  let budget: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(
      urls.map((src) => {
        const image = new Image();
        // Same request mode as <TemplateArtwork>, so its <img> reuses this response.
        image.crossOrigin = "anonymous";
        image.referrerPolicy = "no-referrer";
        image.src = src;
        return image.decode().catch(() => undefined);
      }),
    ),
    new Promise((resolve) => {
      budget = setTimeout(resolve, ARTWORK_REVEAL_BUDGET_MS);
    }),
  ]);
  clearTimeout(budget);
}

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
