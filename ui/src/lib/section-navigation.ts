import { createSignal, onSettled } from "solid-js";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationNavigationOptions } from "../app/context-types.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../app/gateway.ts";

/** Sections whose sidebar lists their items, so their landing page waits for one to open. */
export type ListingSection = "automations";

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
  setOpened((entries) => {
    const current = entries.get(section);
    // Writing the same location again would wake every reader for nothing.
    if (
      current?.scope === scope &&
      current.location.route === location.route &&
      current.location.options.search === location.options.search &&
      current.location.options.pathname === location.options.pathname
    ) {
      return entries;
    }
    return new Map(entries).set(section, { scope, location });
  });
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

// Each listing section's sidebar reports whether its scope has anything to list, so the shell
// shows only the rail beside a section with nothing in it. An unreported or unread section lists.
const [itemSources, setItemSources] = createSignal<
  ReadonlyMap<ListingSection, () => boolean | undefined>
>(new Map());

/** The section's source for whether it lists anything, for as long as the calling owner lives. */
export function createSectionItemsSource(
  section: ListingSection,
  read: () => boolean | undefined,
): void {
  onSettled(() => {
    setItemSources((current) => new Map(current).set(section, read));
    return () =>
      setItemSources((current) => {
        if (current.get(section) !== read) {
          return current;
        }
        const next = new Map(current);
        next.delete(section);
        return next;
      });
  });
}

export function sectionListsItems(section: ListingSection): boolean {
  return itemSources().get(section)?.() !== false;
}
