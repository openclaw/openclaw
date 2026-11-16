import type { ControlUiContributions, ControlUiRegistration } from "./control-ui-capability.ts";

type NavigationRegistration = ControlUiRegistration<ControlUiContributions["navigation"]>;

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
