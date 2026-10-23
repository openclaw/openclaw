import { anchorFromNavigationEvent } from "../lib/navigation-click.ts";
import {
  hovercardBootstrapIntentActive,
  LazyHovercardBootstrap,
  remainingHovercardOpenDelay,
  type HovercardBootstrapTrigger,
} from "./lazy-hovercard-registration.ts";
import type { LinkReaderHovercardProvider } from "./link-reader-hovercard.ts";
import {
  LINK_READER_HOVERCARD_OPEN_DELAY_MS,
  LINK_READER_HOVERCARD_PROVIDER_TAG,
  resolveHoverPreviewTarget,
} from "./link-reader-target.ts";

export const HOVER_PREVIEW_UNAVAILABLE_EVENT = "link-reader-hover-preview-unavailable";
let runtimeLoadFailed = false;

export const linkReaderHovercardBootstrap = new LazyHovercardBootstrap<LinkReaderHovercardProvider>(
  {
    tag: LINK_READER_HOVERCARD_PROVIDER_TAG,
    load: async () => {
      try {
        const provider = (await import("./link-reader-hovercard.ts")).LinkReaderHovercardProvider;
        runtimeLoadFailed = false;
        return provider;
      } catch (error) {
        runtimeLoadFailed = true;
        throw error;
      }
    },
  },
);

/** Hover may use public page metadata; transcript prefetch remains reader-only. */
function hoverTargetForAnchor(anchor: HTMLAnchorElement) {
  const owner = linkReaderHovercardBootstrap.providerFor(anchor);
  return owner ? resolveHoverPreviewTarget(anchor, owner) : null;
}

export function ownsHoverPreview(anchor: HTMLAnchorElement): boolean {
  const target = hoverTargetForAnchor(anchor);
  // Reserve reader hints while loading, but release them after a failed import.
  return Boolean(
    target &&
    (customElements.get(LINK_READER_HOVERCARD_PROVIDER_TAG) ||
      (target.reader && !runtimeLoadFailed)),
  );
}

async function activateHovercard(event: Event, trigger: HovercardBootstrapTrigger): Promise<void> {
  if (trigger === "pointer" && event instanceof PointerEvent && event.pointerType === "touch") {
    return;
  }
  const anchor = anchorFromNavigationEvent(event);
  const target = anchor ? hoverTargetForAnchor(anchor) : null;
  if (target && !target.reader && trigger === "focus" && !anchor?.matches(":focus-visible")) {
    return;
  }
  if (!anchor || !target) {
    return;
  }
  const triggerTarget = event.composedPath()[0];
  const startedAt = performance.now();
  try {
    await linkReaderHovercardBootstrap.define();
  } catch {
    if (anchor.isConnected && hovercardBootstrapIntentActive(anchor, trigger)) {
      // Refresh the existing title owner without replaying pointer/focus input or another load.
      (triggerTarget instanceof Element ? triggerTarget : anchor).dispatchEvent(
        new CustomEvent(HOVER_PREVIEW_UNAVAILABLE_EVENT, {
          bubbles: true,
          composed: true,
          detail: trigger,
        }),
      );
    }
    return;
  }
  const provider = linkReaderHovercardBootstrap.providerFor(anchor);
  // Wait for the host to replay values assigned before the lazy upgrade.
  await provider?.updateComplete;
  const current = hoverTargetForAnchor(anchor);
  if (
    !provider ||
    !current ||
    !anchor.isConnected ||
    current?.reader !== target.reader ||
    current.href !== target.href ||
    !hovercardBootstrapIntentActive(anchor, trigger)
  ) {
    return;
  }
  provider.activateFromBootstrap(
    anchor,
    target,
    trigger,
    trigger === "pointer"
      ? remainingHovercardOpenDelay(startedAt, LINK_READER_HOVERCARD_OPEN_DELAY_MS)
      : 0,
  );
}

linkReaderHovercardBootstrap.install(activateHovercard);
