import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import { ensureCanonicalUserProfileForEmail } from "./user-profile-writes.js";

/** Email authentication shares the profile owner's committed bindings and creation path. */
export async function ensureProfileIdForEmail(
  email: string,
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> = {},
  assertCurrent?: () => void,
): Promise<string> {
  assertCurrent?.();
  return (await ensureCanonicalUserProfileForEmail(email, { ...options, assertCurrent })).id;
}
