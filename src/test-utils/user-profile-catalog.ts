import { afterEach } from "vitest";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureUserProfilesSchema } from "../state/user-profiles-schema.js";

/** Mirror Gateway boot admission before a fixture calls synchronous profile policy. */
export async function prepareUserProfileCatalogForTest(options: OpenClawStateDatabaseOptions = {}) {
  ensureUserProfilesSchema(options);
  return await prepareUserProfileCatalog(options);
}
export function useUserProfileCatalogForTest() {
  const releases = new Set<() => void>();
  afterEach(() => {
    for (const release of releases) {
      release();
    }
    releases.clear();
  });
  return async (options?: OpenClawStateDatabaseOptions) => {
    const catalog = await prepareUserProfileCatalogForTest(options);
    releases.add(catalog.release);
    return catalog;
  };
}
