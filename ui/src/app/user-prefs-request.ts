import type {
  UsersPrefsGetParams,
  UsersPrefsGetResult,
} from "../../../packages/gateway-protocol/src/schema/users.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { userPreferenceReads as reads } from "./user-prefs-cache.ts";

/** Retain each profile projection until a save, publication, or connection boundary. */
export function loadUserPreferences(
  client: GatewayBrowserClient,
  profileId: string,
  params: UsersPrefsGetParams = {},
): Promise<UsersPrefsGetResult> {
  let cache = reads.get(client);
  if (!cache) {
    cache = new Map();
    reads.set(client, cache);
  }
  const key = JSON.stringify([profileId, params.keys?.toSorted()]);
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  const pending = client.request<UsersPrefsGetResult>("users.prefs.get", params);
  cache.set(key, pending);
  const retire = () => {
    if (cache.get(key) === pending) {
      cache.delete(key);
    }
  };
  void pending.then((result) => {
    if (result.status !== "ok") {
      retire();
    }
  }, retire);
  return pending;
}
