import type { ControlUiContributions, ControlUiRegistration } from "./control-ui-capability.ts";

type NavigationRegistration = ControlUiRegistration<ControlUiContributions["navigation"]>;

/**
 * The plugin page open at a route: a plugin tab's own key, or the plugin page the Gateway
 * places on a native route (Workboard at /workboard).
 */
export function pluginPageKeyForRoute(
  route: string,
  pluginTabKey: string | undefined,
  tabs: readonly { pluginId: string; id: string; placement?: string }[],
): string | undefined {
  if (pluginTabKey) {
    return pluginTabKey;
  }
  const tab = tabs.find((candidate) => candidate.placement === `route:${route}`);
  return tab ? `${tab.pluginId}/${tab.id}` : undefined;
}

const sameParent = (child: NavigationRegistration, parent: NavigationRegistration) =>
  child.pluginId === parent.pluginId && child.value.parent === parent.value.id;

const hasChildren = (
  registrations: readonly NavigationRegistration[],
  parent: NavigationRegistration,
) => registrations.some((child) => sameParent(child, parent));

/**
 * The plugin navigation item with children, such as Workboard and its boards, whose page or
 * one of whose children's pages is open. That page shows the children in a sidebar of its own.
 */
export function navigationSectionForPage(
  registrations: readonly NavigationRegistration[],
  pluginKey: string | undefined,
): NavigationRegistration | undefined {
  const slash = pluginKey?.indexOf("/") ?? -1;
  if (!pluginKey || slash < 0) {
    return undefined;
  }
  const pluginId = pluginKey.slice(0, slash);
  const pageId = pluginKey.slice(slash + 1);
  const onPage = registrations.filter(
    (entry) => entry.pluginId === pluginId && entry.value.page.id === pageId,
  );
  const parentId =
    onPage.find((entry) => !entry.value.parent && hasChildren(registrations, entry))?.value.id ??
    onPage.find((entry) => entry.value.parent)?.value.parent;
  return registrations.find(
    (entry) =>
      entry.pluginId === pluginId &&
      entry.value.id === parentId &&
      !entry.value.parent &&
      hasChildren(registrations, entry),
  );
}

type OpenLocation = Pick<Location, "href" | "pathname" | "search">;

/** Whether an item's page is the one open: the same path, with every query value it names. */
function pageOpen(entry: NavigationRegistration, location: OpenLocation): boolean {
  const target = new URL(entry.host.navigation.pageHref(entry.value.page), location.href);
  const search = new URLSearchParams(location.search);
  return (
    target.pathname === location.pathname &&
    [...target.searchParams].every(([key, value]) => search.get(key) === value)
  );
}

/**
 * Whether a navigation item reads as where you are. Standing for its whole section, as on the
 * rail and in the pages menu where its children are not listed, a child's open page counts too.
 */
export function navigationItemCurrent(
  registrations: readonly NavigationRegistration[],
  entry: NavigationRegistration,
  location: OpenLocation,
  section: boolean,
): boolean {
  const childOpen = () =>
    registrations.some((child) => sameParent(child, entry) && pageOpen(child, location));
  // A child can share its parent's path and select its page through query parameters.
  // Only an item representing the whole section also marks its children's pages.
  return section
    ? pageOpen(entry, location) || childOpen()
    : pageOpen(entry, location) && !childOpen();
}

/** A child shown in its parent's section; one whose parent is not registered stands alone. */
export function isNavigationSectionChild(
  registrations: readonly NavigationRegistration[],
  entry: NavigationRegistration,
): boolean {
  return Boolean(
    entry.value.parent &&
    registrations.some(
      (parent) => parent.pluginId === entry.pluginId && parent.value.id === entry.value.parent,
    ),
  );
}

/** A section's children in the plugin's order, then by label. */
export function navigationSectionChildren(
  registrations: readonly NavigationRegistration[],
  parent: NavigationRegistration,
): NavigationRegistration[] {
  return registrations
    .filter((child) => sameParent(child, parent))
    .toSorted(
      (left, right) =>
        (left.value.order ?? 0) - (right.value.order ?? 0) ||
        left.value.label.localeCompare(right.value.label),
    );
}
