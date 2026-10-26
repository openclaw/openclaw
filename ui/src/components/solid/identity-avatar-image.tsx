import { createEffect, createMemo, createSignal, onSettled, type Accessor } from "solid-js";
import { recordAvatarImageError, retainAvatarImageUrl } from "../../lib/identity-avatar-loader.ts";
import { listen } from "../../lib/reactive/listener.ts";

type IdentityAvatarImageProps = {
  view: { imageUrl: string | Promise<string | null> | null };
  onStateChange: (outcome: ImageOutcome) => void;
  class?: string;
  alt?: string;
  ariaHidden?: boolean;
  onImageError?: () => void;
};

type ImageOutcome = {
  source: IdentityAvatarImageProps["view"]["imageUrl"];
  url: string | null;
  state: "pending" | "loaded" | "failed";
};

/** Known image URLs paint over their fallback without waiting for a decode event. */
export function createIdentityAvatarPresentation(
  view: Accessor<IdentityAvatarImageProps["view"] & { pending: boolean }>,
) {
  const [outcome, setOutcome] = createSignal<ImageOutcome>();
  const state = createMemo(() => {
    const value = view();
    if (!value.imageUrl) {
      return value.pending ? "pending" : "none";
    }
    const current = outcome();
    return current &&
      (current.source === value.imageUrl ||
        (typeof value.imageUrl === "string" && current.url === value.imageUrl))
      ? current.state
      : typeof value.imageUrl === "string"
        ? "loaded"
        : "pending";
  });
  return {
    state,
    classes: () => ({
      "is-pending": state() === "pending",
      "is-fallback": state() === "none" || state() === "failed",
    }),
    onStateChange: (value: ImageOutcome) => setOutcome(value),
  };
}

/** The existing loader owns image resources; this binding owns DOM state and events. */
export function IdentityAvatarImage(props: IdentityAvatarImageProps) {
  let image: HTMLImageElement;
  let release: (() => void) | undefined;
  let activeSource: IdentityAvatarImageProps["view"]["imageUrl"] = null;
  const state = (value: ImageOutcome["state"], url = image.getAttribute("src")) => {
    props.onStateChange({ source: activeSource, url, state: value });
  };
  const load = () => state("loaded");
  const error = () => {
    recordAvatarImageError(activeSource);
    state("failed");
    props.onImageError?.();
  };
  // Keep the pending resource opaque: returning its Promise would make this an async memo.
  const source = createMemo(() => ({ result: props.view.imageUrl }), {
    equals: (previous, next) => previous.result === next.result,
  });
  createEffect(source, ({ result }) => {
    activeSource = result;
    const nextRelease = retainAvatarImageUrl(result);
    release?.();
    release = nextRelease;
    let active = true;
    const apply = (url: string | null) => {
      if (!active) {
        return;
      }
      if (!url || image.getAttribute("src") !== url) {
        state(url ? "loaded" : "failed", url);
        if (url) {
          image.setAttribute("src", url);
        } else {
          image.removeAttribute("src");
        }
      }
    };
    if (typeof result === "string" || result === null) {
      apply(result);
    } else {
      image.removeAttribute("src");
      state("pending");
      void result.then(apply);
    }
    return () => {
      active = false;
    };
  });
  // Retired image nodes can still emit errors after a replacement owns the avatar.
  onSettled(() => {
    const cleanup = [() => release?.(), listen(image, "load", load), listen(image, "error", error)];
    return () => cleanup.forEach((stop) => stop());
  });
  return (
    <img
      ref={(element) => {
        image = element;
      }}
      class={props.class}
      alt={props.alt ?? ""}
      aria-hidden={props.ariaHidden ? "true" : undefined}
      referrerpolicy="no-referrer"
      decoding="async"
    />
  );
}
