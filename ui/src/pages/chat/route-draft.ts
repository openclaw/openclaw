import type { RouteLocation } from "@openclaw/uirouter";
import {
  SESSION_COMPOSER_FOCUS_PARAM,
  SESSION_DASHBOARD_EXPANDED_PARAM,
} from "../../lib/sessions/route-navigation.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";

type RouteDraftData = { sessionKey: string; draft?: string };

export function sessionRouteHints(location: RouteLocation) {
  const search = new URLSearchParams(location.search);
  return {
    draft: search.get("draft") || undefined,
    ...(search.get(SESSION_COMPOSER_FOCUS_PARAM) === "1" ? { focusComposer: true as const } : {}),
    ...(search.get(SESSION_DASHBOARD_EXPANDED_PARAM) === "expanded"
      ? { dashboardExpanded: true as const }
      : {}),
  };
}

export function locationWithoutDraft(
  location: RouteLocation,
  destination: Partial<RouteLocation> = {},
): RouteLocation {
  const params = new URLSearchParams(location.search);
  for (const [name, value] of new URLSearchParams(destination.search)) {
    params.set(name, value);
  }
  params.delete("draft");
  params.delete(SESSION_COMPOSER_FOCUS_PARAM);
  const search = params.toString();
  return { ...location, ...destination, search: search ? `?${search}` : "" };
}

export function draftSearchFromLocation(location: RouteLocation): string {
  const search = new URLSearchParams();
  const { draft, focusComposer } = sessionRouteHints(location);
  if (draft) {
    search.set("draft", draft);
  }
  if (focusComposer) {
    search.set(SESSION_COMPOSER_FOCUS_PARAM, "1");
  }
  return search.size > 0 ? "?" + search.toString() : "";
}

// A one-shot route draft belongs only to its matching pane until the page consumes it.
export function routeDraft(
  data: RouteDraftData | null | undefined,
  consumed: RouteDraftData | null,
  sessionKey = data?.sessionKey,
): string | undefined {
  return !data || !areUiSessionKeysEquivalent(sessionKey, data.sessionKey) || consumed === data
    ? undefined
    : data.draft;
}
