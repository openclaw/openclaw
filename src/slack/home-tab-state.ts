/**
 * Shared Home Tab state for coordinating between the `app_home_opened` event
 * handler and the `publishSlackHomeTab` action.
 *
 * Both modules import from here so they share the same in-memory caches.
 * State is cleared on process restart (a fresh publish after restart is desirable).
 */

/**
 * Per-user cache of the VERSION string at the time the default Home Tab view
 * was last published. Avoids redundant `views.publish` calls when the view
 * hasn't changed.
 */
const publishedVersionByUser = new Map<string, string>();

/**
 * Set of user IDs whose Home Tab is currently showing a custom (agent-pushed)
 * view. While a user is in this set the default `app_home_opened` handler
 * will skip publishing the default view.
 */
const customViewUsers = new Set<string>();

/** Mark a user as having a custom (agent-pushed) Home Tab view. */
export function markHomeTabCustom(userId: string): void {
  customViewUsers.add(userId);
  publishedVersionByUser.delete(userId);
}

/** Clear the custom-view flag so the default view can be published again. */
export function clearHomeTabCustom(userId: string): void {
  customViewUsers.delete(userId);
}

/** Returns `true` if the user currently has a custom Home Tab view. */
export function hasCustomHomeTab(userId: string): boolean {
  return customViewUsers.has(userId);
}

/** Record that the default Home Tab was published for `userId` at `version`. */
export function markHomeTabPublished(userId: string, version: string): void {
  publishedVersionByUser.set(userId, version);
}

/** Returns `true` if the user already has the default view at `version`. */
export function hasCurrentHomeTab(userId: string, version: string): boolean {
  return publishedVersionByUser.get(userId) === version;
}

/** Reset all state. @internal For testing only. */
export function resetHomeTabState(): void {
  publishedVersionByUser.clear();
  customViewUsers.clear();
}
