import { createEffect, createMemo, onCleanup, untrack, type Accessor } from "solid-js";
import { readAvatarGatewayContext } from "../../lib/identity-avatar-context.ts";
import { resolveAvatarImageUrl, retainAvatarImageUrl } from "../../lib/identity-avatar-loader.ts";
import { resolveTrustedAvatarUrl } from "../../lib/identity-avatar.ts";
import type { IdentityAvatarView } from "../identity-avatar-view.ts";

export type IdentityAvatarImageProps = {
  view: Pick<IdentityAvatarView, "imageUrl" | "sourceUrl">;
  fallbackSelector: string;
  class?: string;
  alt?: string;
  ariaHidden?: boolean;
  onImageError?: () => void;
  /** The Lit adapter supplies its existing image, preserving direct-child selectors. */
  element?: HTMLImageElement;
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
  view: Accessor<Pick<IdentityAvatarView, "imageUrl" | "pending">>,
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

/** One image owns its pending and displayed resource until replacement or disposal. */
export function IdentityAvatarImage(props: IdentityAvatarImageProps) {
  const suppliedElement = untrack(() => props.element);
  let image = suppliedElement;
  let currentUrl: string | null = null;
  let release: (() => void) | undefined;
  const source = createMemo(
    () => [props.view.imageUrl, props.view.sourceUrl, props.fallbackSelector] as const,
    { equals: (previous, next) => previous.every((value, index) => value === next[index]) },
  );
  const settle = (failed: boolean) => {
    const wrapper = image?.closest(props.fallbackSelector);
    if (wrapper) {
      setIdentityAvatarState(wrapper, failed ? "failed" : "loaded");
    }
    if (failed) {
      props.onImageError?.();
    }
  };
  createEffect(source, ([imageUrl, sourceUrl, selector]) => {
    const element = image!;
    const wrapper = () => element.closest(selector);
    const inputUrl = sourceUrl ?? (typeof imageUrl === "string" ? imageUrl : undefined);
    const trusted = inputUrl
      ? resolveTrustedAvatarUrl(inputUrl, readAvatarGatewayContext().origin)
      : null;
    const result = trusted && imageUrl === inputUrl ? resolveAvatarImageUrl(trusted) : imageUrl;
    // Retain the replacement before releasing: the cache can evict zero-reference entries.
    const nextRelease = retainAvatarImageUrl(result);
    release?.();
    release = nextRelease;
    let active = true;
    const apply = (url: string | null) => {
      if (!active) {
        return;
      }
      const changed = currentUrl !== url;
      currentUrl = url;
      if (url) {
        element.setAttribute("src", url);
      } else {
        element.removeAttribute("src");
      }
      const frame = wrapper();
      if (frame && (changed || !url)) {
        setIdentityAvatarState(frame, url ? "pending" : "failed");
      }
      // The Lit adapter can assign src before its image joins the wrapper.
      queueMicrotask(() =>
        untrack(() => {
          if (active && url && currentUrl === url && element.complete && element.naturalWidth > 0) {
            settle(false);
          }
        }),
      );
    };
    if (typeof result === "string" || result === null) {
      apply(result);
    } else {
      currentUrl = null;
      element.removeAttribute("src");
      const frame = wrapper();
      if (frame) {
        setIdentityAvatarState(frame, "pending");
      }
      void result.then((url) => untrack(() => apply(url)));
    }
    return () => {
      active = false;
    };
  });
  const load = () => settle(false);
  const error = () => settle(true);
  createEffect(
    () => null,
    () => {
      const element = image!;
      element.addEventListener("load", load);
      element.addEventListener("error", error);
      return () => {
        element.removeEventListener("load", load);
        element.removeEventListener("error", error);
      };
    },
  );
  onCleanup(() => {
    release?.();
    currentUrl = null;
  });
  return (
    <>
      {suppliedElement ?? (
        <img
          ref={(element) => {
            image = element;
          }}
          class={props.class}
          alt={props.alt ?? ""}
          aria-hidden={props.ariaHidden ? "true" : undefined}
          referrerpolicy="no-referrer"
        />
      )}
    </>
  );
}
