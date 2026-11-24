import { createSignal, Show } from "solid-js";
import { fnv1aUtf16 } from "../../../../src/shared/fnv1a.js";
import { Icon } from "../../components/solid/icon.tsx";

const ARTWORK_REVEAL_BUDGET_MS = 500;
// Fixed decorative inks measured against the catalog and detail tiles in both schemes.
const CATALOG_AVATAR_INKS = ["#b0635b", "#896da4", "#458378", "#9c6f3e", "#63805c", "#6078aa"];

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

function TemplateArtworkFallback(props: { packageName?: string }) {
  return (
    <Icon
      name="blobster"
      style={
        props.packageName
          ? {
              color:
                CATALOG_AVATAR_INKS[fnv1aUtf16(props.packageName) % CATALOG_AVATAR_INKS.length],
              "stroke-width": "1.55px",
            }
          : undefined
      }
    />
  );
}

/** The catalog passes its canonical package name; other surfaces keep their inherited ink. */
export function TemplateArtwork(props: { src?: string; packageName?: string }) {
  return (
    <Show
      when={props.src}
      keyed
      fallback={<TemplateArtworkFallback packageName={props.packageName} />}
    >
      {(src) => {
        const [failed, setFailed] = createSignal(false);
        return (
          <Show
            when={!failed()}
            fallback={<TemplateArtworkFallback packageName={props.packageName} />}
          >
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
