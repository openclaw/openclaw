import type { RouteLocation } from "@openclaw/uirouter";
import { sameRouteLocation } from "../../app-route-paths.ts";
import { locationWithoutDraft } from "./route-draft.ts";

export function currentRouteLocation(): RouteLocation {
  return {
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
  };
}

export function stillOwnsCanonicalLocation(
  source: RouteLocation | undefined,
  consumedSourceDraft: boolean,
): boolean {
  if (!source) {
    return false;
  }
  const current = currentRouteLocation();
  if (sameRouteLocation(current, source)) {
    return true;
  }
  const sourceHasDraft = new URLSearchParams(source.search).has("draft");
  const currentHasDraft = new URLSearchParams(current.search).has("draft");
  // Only the source route's own one-shot draft may disappear without
  // transferring canonicalization ownership to a newer navigation.
  return (
    consumedSourceDraft &&
    sourceHasDraft &&
    !currentHasDraft &&
    sameRouteLocation(locationWithoutDraft(current), locationWithoutDraft(source))
  );
}
