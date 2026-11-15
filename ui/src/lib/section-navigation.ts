import { onCleanup } from "solid-js";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationNavigationOptions } from "../app/context-types.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../app/gateway.ts";

/** Sections whose sidebar lists their items, so their landing page waits for one to open. */
export type ListingSection = "automations" | "dashboards";

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

// The shell reports which section's sidebar stands open beside the page, from its own route and
// layout, so a section's page knows before its first frame whether its sidebar lists the items.
let shownSection: () => string | undefined = () => undefined;

/** The shell's source for the shown section, for as long as the calling owner lives. */
export function createSectionSidebarSource(read: () => string | undefined): void {
  shownSection = read;
  onCleanup(() => {
    if (shownSection === read) {
      shownSection = () => undefined;
    }
  });
}

export function sectionSidebarShown(section: ListingSection): boolean {
  return shownSection() === section;
}
