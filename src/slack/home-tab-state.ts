/**
 * Shared Home Tab state for coordinating between the `app_home_opened` event
 * handler and the `publishSlackHomeTab` action.
 *
 * Both modules import from here so they share the same in-memory caches.
 *
 * State is keyed by `accountId:userId` to prevent cross-contamination in
 * multi-account setups (Slack user IDs are workspace-local and can collide).
 */

function stateKey(accountId: string, userId: string): string {
  return `${accountId}:${userId}`;
}

/**
 * Per-user cache of the VERSION string at the time the default Home Tab view
 * was last published. Cleared on process restart (a fresh publish after
 * restart is desirable).
 */
const publishedVersionByUser = new Map<string, string>();

/**
 * Set of (accountId:userId) keys whose Home Tab is currently showing a custom
 * (agent-pushed) view. While a key is in this set the default `app_home_opened`
 * handler will skip publishing the default view.
 */
const customViewUsers = new Set<string>();

/**
 * Set of (accountId:userId) keys that currently have an in-flight publish.
 * Used to deduplicate concurrent `app_home_opened` events for the same user.
 */
const publishingInFlight = new Set<string>();

/** Mark a user as having a custom (agent-pushed) Home Tab view. */
export function markHomeTabCustom(accountId: string, userId: string): void {
  const key = stateKey(accountId, userId);
  customViewUsers.add(key);
  publishedVersionByUser.delete(key);
}

/** Clear the custom-view flag so the default view can be published again. */
export function clearHomeTabCustom(accountId: string, userId: string): void {
  customViewUsers.delete(stateKey(accountId, userId));
}

/** Returns `true` if the user currently has a custom Home Tab view. */
export function hasCustomHomeTab(accountId: string, userId: string): boolean {
  return customViewUsers.has(stateKey(accountId, userId));
}

/** Record that the default Home Tab was published for `userId` at `version`. */
export function markHomeTabPublished(accountId: string, userId: string, version: string): void {
  publishedVersionByUser.set(stateKey(accountId, userId), version);
}

/** Returns `true` if the user already has the default view at `version`. */
export function hasCurrentHomeTab(accountId: string, userId: string, version: string): boolean {
  return publishedVersionByUser.get(stateKey(accountId, userId)) === version;
}

/** Returns `true` if a publish is currently in-flight for this user. */
export function isPublishInFlight(accountId: string, userId: string): boolean {
  return publishingInFlight.has(stateKey(accountId, userId));
}

/** Mark a publish as in-flight. */
export function markPublishInFlight(accountId: string, userId: string): void {
  publishingInFlight.add(stateKey(accountId, userId));
}

/** Clear the in-flight flag. */
export function clearPublishInFlight(accountId: string, userId: string): void {
  publishingInFlight.delete(stateKey(accountId, userId));
}

/** Reset all state. @internal For testing only. */
export function resetHomeTabState(): void {
  publishedVersionByUser.clear();
  customViewUsers.clear();
  publishingInFlight.clear();
}
