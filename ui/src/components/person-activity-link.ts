import { activityPersonLocation } from "../app-route-paths.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";

/**
 * Routing an identity surface needs to open one person's Activity feed. Hosts pass it
 * explicitly because some surfaces (the portaled session hovercard) render outside the
 * application context tree and cannot consume it.
 */
export type PersonActivityRouting = {
  basePath: string;
  navigate: (personId: string, label?: string) => void;
};

type PersonActivityLink = { href: string; open: (event: MouseEvent) => void };

/** Structural view of the application context, so identity chrome stays out of app/ imports. */
type PersonActivityNavigator = {
  readonly basePath: string;
  navigate: (routeId: "activity", options: { pathname: string; search: string }) => void;
};

/** `beforeNavigate` lets transient hosts (hovercards, popovers) dismiss themselves first. */
export function personActivityRouting(
  context: PersonActivityNavigator,
  beforeNavigate?: () => void,
): PersonActivityRouting {
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
): PersonActivityLink | null {
  const id = personId?.trim();
  if (!id || !routing) {
    return null;
  }
  return {
    href: activityPersonLocation(id, routing.basePath, label).href,
    open: (event: MouseEvent) => {
      if (!shouldHandleNavigationClick(event)) {
        return;
      }
      event.preventDefault();
      routing.navigate(id, label);
    },
  };
}
