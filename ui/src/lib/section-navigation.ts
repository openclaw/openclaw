import { createSignal, onCleanup, untrack } from "solid-js";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationNavigationOptions } from "../app/context-types.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../app/gateway.ts";

/** Sections whose sidebar lists their items, so their landing page waits for one to open. */
export type ListingSection = "automations" | "dashboards";

export type SectionLocation = { route: RouteId; options: ApplicationNavigationOptions };

// The page last opened from each section in this tab, per Gateway, so returning reopens it.
// It is a signal so a section's sidebar can mark the item its page has open.
type OpenedEntry = {
  scope: ReturnType<typeof gatewayPresentationScope>;
  location: SectionLocation;
};
const [opened, setOpened] = createSignal<ReadonlyMap<ListingSection, OpenedEntry>>(new Map());

export function sectionLocation(
  gateway: ApplicationGateway,
  section: ListingSection,
): SectionLocation | null {
  const entry = opened().get(section);
  return entry?.scope === gatewayPresentationScope(gateway) ? entry.location : null;
}

export function rememberSectionLocation(
  gateway: ApplicationGateway,
  section: ListingSection,
  location: SectionLocation | null,
): void {
  if (!location) {
    forgetSectionLocation(section);
    return;
  }
  const scope = gatewayPresentationScope(gateway);
  const current = untrack(opened).get(section);
  // Writing the same location again would wake every reader for nothing.
  if (
    current?.scope === scope &&
    current.location.route === location.route &&
    current.location.options.search === location.options.search &&
    current.location.options.pathname === location.options.pathname
  ) {
    return;
  }
  setOpened((entries) => new Map(entries).set(section, { scope, location }));
}

/** Choosing a section again starts it over, whichever Gateway it was opened on. */
export function forgetSectionLocation(section: ListingSection): void {
  setOpened((current) => {
    if (!current.has(section)) {
      return current;
    }
    const next = new Map(current);
    next.delete(section);
    return next;
  });
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
