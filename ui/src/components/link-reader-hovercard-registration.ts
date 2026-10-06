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

export const linkReaderHovercardBootstrap = new LazyHovercardBootstrap<LinkReaderHovercardProvider>(
  {
    tag: LINK_READER_HOVERCARD_PROVIDER_TAG,
    load: async () => (await import("./link-reader-hovercard.ts")).LinkReaderHovercardProvider,
  },
);

/** Hover may use public page metadata; transcript prefetch remains reader-only. */
function hoverTargetForAnchor(anchor: HTMLAnchorElement) {
  const owner = linkReaderHovercardBootstrap.providerFor(anchor);
  return owner ? resolveHoverPreviewTarget(anchor, owner) : null;
}

export function ownsHoverPreview(anchor: HTMLAnchorElement): boolean {
  const target = hoverTargetForAnchor(anchor);
  // Cold public-page imports can fail: keep title hints until a runtime exists.
  return Boolean(
    target && (target.reader || customElements.get(LINK_READER_HOVERCARD_PROVIDER_TAG)),
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
  const startedAt = performance.now();
  try {
    await linkReaderHovercardBootstrap.define();
  } catch {
    return;
  }
  const provider = linkReaderHovercardBootstrap.providerFor(anchor);
  // Definition can precede Lit replaying values assigned before the lazy upgrade.
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
