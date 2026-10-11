import { createEffect, createMemo, onCleanup, untrack, type Accessor } from "solid-js";
import { retainAvatarImageUrl } from "../../lib/identity-avatar-loader.ts";

export type IdentityAvatarImageProps = {
  view: { imageUrl: string | Promise<string | null> | null; sourceUrl?: string };
  fallbackSelector: string;
  class?: string;
  alt?: string;
  ariaHidden?: boolean;
  onImageError?: () => void;
};

export function setIdentityAvatarState(
  element: Element,
  state: "none" | "pending" | "loaded" | "failed",
) {
  element.setAttribute("data-avatar-state", state);
  element.classList.toggle("is-pending", state === "pending");
  element.classList.toggle("is-fallback", state === "none" || state === "failed");
}

/** An image owns loaded/failed; frames without an image still need their fallback. */
export function identityAvatarState(
  view: Accessor<IdentityAvatarImageProps["view"] & { pending: boolean }>,
) {
  let frame: HTMLElement;
  createEffect(view, (value) => {
    if (!value.imageUrl) {
      setIdentityAvatarState(frame, value.pending ? "pending" : "none");
    }
  });
  return (element: HTMLElement) => {
    frame = element;
  };
}

/** Shared by native JSX and the Lit adapter; the existing loader owns all image resources. */
export function bindIdentityAvatarImage(input: Accessor<IdentityAvatarImageProps>) {
  let image: HTMLImageElement;
  let release: (() => void) | undefined;
  const state = (value: "pending" | "loaded" | "failed") => {
    const frame = image.closest(untrack(() => input().fallbackSelector));
    if (frame) {
      setIdentityAvatarState(frame, value);
    }
  };
  const load = () => state("loaded");
  const error = () => {
    state("failed");
    input().onImageError?.();
  };
  // Keep the pending resource opaque: returning its Promise would make this an async memo.
  const source = createMemo(() => ({ result: input().view.imageUrl }), {
    equals: (previous, next) => previous.result === next.result,
  });
  createEffect(source, ({ result }) => {
    const nextRelease = retainAvatarImageUrl(result);
    release?.();
    release = nextRelease;
    let active = true;
    const apply = (url: string | null) => {
      if (!active) {
        return;
      }
      if (image.getAttribute("src") !== url || !url) {
        state(url ? "pending" : "failed");
      }
      if (url) {
        image.setAttribute("src", url);
      } else {
        image.removeAttribute("src");
      }
      // Lit can supply an image before inserting it into its wrapper; cached decodes emit no event.
      queueMicrotask(() =>
        untrack(() => {
          if (
            active &&
            url &&
            image.getAttribute("src") === url &&
            image.complete &&
            image.naturalWidth > 0
          ) {
            load();
          }
        }),
      );
    };
    if (typeof result === "string" || result === null) {
      apply(result);
    } else {
      image.removeAttribute("src");
      state("pending");
      void result.then((url) => untrack(() => apply(url)));
    }
    return () => {
      active = false;
    };
  });
  onCleanup(() => {
    image.removeEventListener("load", load);
    image.removeEventListener("error", error);
    release?.();
  });
  return (element: HTMLImageElement) => {
    image = element;
    image.addEventListener("load", load);
    image.addEventListener("error", error);
  };
}

export function IdentityAvatarImage(props: IdentityAvatarImageProps) {
  return (
    <img
      ref={bindIdentityAvatarImage(() => props)}
      class={props.class}
      alt={props.alt ?? ""}
      aria-hidden={props.ariaHidden ? "true" : undefined}
      referrerpolicy="no-referrer"
    />
  );
}
