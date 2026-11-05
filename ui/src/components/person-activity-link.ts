import { activityPersonLocation } from "../app-route-paths.ts";
import { handleNavigationClick } from "../lib/navigation-click.ts";

/**
 * Routing an identity surface needs to open one person's Activity feed. Hosts pass it
 * explicitly because some surfaces (the portaled session hovercard) render outside the
 * application context tree and cannot consume it.
 */
export type PersonActivityRouting = ReturnType<typeof personActivityRouting>;

/** `beforeNavigate` lets transient hosts (hovercards, popovers) dismiss themselves first. */
export function personActivityRouting(
  /** Structural view of the application context, so identity chrome stays out of app/ imports. */
  context: {
    readonly basePath: string;
    navigate: (routeId: "activity", options: { pathname: string; search: string }) => void;
  },
  beforeNavigate?: () => void,
) {
  return {
    basePath: context.basePath,
    navigate: (personId: string, label?: string) => {
      beforeNavigate?.();
      context.navigate("activity", activityPersonLocation(personId, context.basePath, label));
    },
  };
}

export function personActivityLink(
  personId: string | null | undefined,
  routing: PersonActivityRouting | undefined,
  label?: string,
): { href: string; open: (event: MouseEvent) => void } | null {
  const id = personId?.trim();
  if (!id || !routing) {
    return null;
  }
  return {
    href: activityPersonLocation(id, routing.basePath, label).href,
    open: (event: MouseEvent) => handleNavigationClick(event, () => routing.navigate(id, label)),
  };
}
