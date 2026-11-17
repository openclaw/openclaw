import { createSignal, onSettled } from "solid-js";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationNavigationOptions } from "../app/context-types.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { mobileNavLayoutMediaQuery } from "../app/mobile-nav-layout.ts";
import { createMediaQuery } from "./reactive/platform.ts";

/** Sections whose sidebar lists their items, so their landing page waits for one to open. */
export type ListingSection = "automations";

export type SectionLocation = { route: RouteId; options: ApplicationNavigationOptions };

// The page last opened from each section in this tab, per Gateway, so returning reopens it.
const opened = new Map<
  ListingSection,
  { scope: ReturnType<typeof gatewayPresentationScope>; location: SectionLocation }
>();

export function sectionLocation(
  gateway: ApplicationGateway,
  section: ListingSection,
): SectionLocation | null {
  const entry = opened.get(section);
  return entry?.scope === gatewayPresentationScope(gateway) ? entry.location : null;
}

export function rememberSectionLocation(
  gateway: ApplicationGateway,
  section: ListingSection,
  location: SectionLocation | null,
): void {
  if (location) {
    opened.set(section, { scope: gatewayPresentationScope(gateway), location });
  } else {
    opened.delete(section);
  }
}

// The section whose sidebar stands open beside the page; its page need not list the items too.
const [sidebar, setSidebar] = createSignal<{
  section: ListingSection;
  shown: () => boolean;
} | null>(null);

export function sectionSidebarShown(section: ListingSection): boolean {
  const presence = sidebar();
  return presence?.section === section && presence.shown();
}

/**
 * Called by a section's sidebar list: it counts as shown while the sidebar is expanded on a
 * desktop layout. The mobile drawer and a collapsed or peeking sidebar do not stand beside it.
 */
export function createSectionSidebarPresence(
  section: ListingSection,
  collapsed: () => boolean,
): void {
  const mobile = createMediaQuery(
    mobileNavLayoutMediaQuery(),
    globalThis.matchMedia?.(mobileNavLayoutMediaQuery()).matches ?? false,
  );
  const presence = { section, shown: () => !collapsed() && !mobile() };
  onSettled(() => {
    setSidebar(presence);
    return () => setSidebar((current) => (current === presence ? null : current));
  });
}
