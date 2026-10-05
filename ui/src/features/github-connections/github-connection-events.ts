import { notifyListeners, registerListener } from "../../../../src/shared/listeners.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

// Invalidate renderer copies after personal consent without publishing credentials or authority.
type PersonalConnectionChange = {
  client: GatewayBrowserClient;
  profileId: string;
};
const personalConnectionChanges = new Set<(change: PersonalConnectionChange) => void>();

export function onPersonalGitHubConnectionChanged(
  listener: (change: PersonalConnectionChange) => void,
) {
  return registerListener(personalConnectionChanges, listener);
}
export function notifyPersonalGitHubConnectionChanged(change: PersonalConnectionChange) {
  notifyListeners(personalConnectionChanges, change);
}
