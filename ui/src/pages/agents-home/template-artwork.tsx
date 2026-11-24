import { createSignal, onSettled, Show } from "solid-js";
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

// Artwork the catalog is showing right now, by source. An Add reuses it as the new agent's
// first avatar, so nothing is fetched or awaited between the click and the chat. An image
// stays here for as long as its card is mounted, however many others load after it.
const AVATAR_PIXELS = 128;
const mountedArtwork = new Map<string, Set<HTMLImageElement>>();

function retainMountedArtwork(src: string, image: HTMLImageElement): () => void {
  const images = mountedArtwork.get(src) ?? new Set();
  mountedArtwork.set(src, images.add(image));
  return () => {
    images.delete(image);
    if (images.size === 0 && mountedArtwork.get(src) === images) {
      mountedArtwork.delete(src);
    }
  };
}

/**
 * A Template's catalog image as a small inline PNG, when the catalog has shown it.
 * Agent avatars render only same-origin or inline image data, never a registry URL,
 * so the decoded pixels are what the chat chrome can show before the agent exists.
 */
export function templateArtworkAvatar(src: string | undefined): string | undefined {
  const image = [...((src && mountedArtwork.get(src)) || [])].find(
    (candidate) => candidate.complete && candidate.naturalWidth > 0,
  );
  const side = image ? Math.min(image.naturalWidth, image.naturalHeight) : 0;
  if (!image || side === 0) {
    return undefined;
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_PIXELS;
    canvas.height = AVATAR_PIXELS;
    const context = canvas.getContext("2d");
    if (!context) {
      return undefined;
    }
    context.drawImage(
      image,
      (image.naturalWidth - side) / 2,
      (image.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      AVATAR_PIXELS,
      AVATAR_PIXELS,
    );
    return canvas.toDataURL("image/png");
  } catch {
    // An image that cannot be read back keeps the generated avatar.
    return undefined;
  }
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
        let image: HTMLImageElement | undefined;
        // Offered to an Add for exactly as long as this artwork is mounted.
        onSettled(() => (image ? retainMountedArtwork(src, image) : undefined));
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
              ref={(element) => {
                image = element;
              }}
              onError={() => setFailed(true)}
            />
          </Show>
        );
      }}
    </Show>
  );
}
