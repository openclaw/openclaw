import type {
  UsersPrefsGetResult,
  UsersPrefsSetParams,
  UsersPrefsSetResult,
} from "../../../packages/gateway-protocol/src/schema/users.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";

// Connection invalidation must not eagerly load the profile request owner.
export const userPreferenceReads = new WeakMap<
  GatewayBrowserClient,
  Map<string, Promise<UsersPrefsGetResult>>
>();

export function invalidateUserPreferences(client: GatewayBrowserClient): void {
  userPreferenceReads.delete(client);
}

export async function saveUserPreferences(
  client: GatewayBrowserClient,
  params: UsersPrefsSetParams,
): Promise<UsersPrefsSetResult> {
  invalidateUserPreferences(client);
  try {
    return await client.request<UsersPrefsSetResult>("users.prefs.set", params);
  } finally {
    invalidateUserPreferences(client);
  }
}
