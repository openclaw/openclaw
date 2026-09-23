import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { normalizeProfileEmail } from "./user-profile-email.kernel.js";

/** Legacy email authentication keeps creation with the existing profile owner. */
export async function ensureProfileIdForEmail(
  email: string,
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> = {},
  assertCurrent?: () => void,
): Promise<string> {
  assertCurrent?.();
  const normalized = normalizeProfileEmail(email);
  const context = captureOpenClawStateWorkerContext(options);
  const selected = { ...options, path: context.admission.databasePath };
  const observed = await executeExistingOpenClawStateRead(selected, {
    type: "userProfiles.email.resolve",
    email: normalized,
  });
  context.admission.assertCurrent();
  assertCurrent?.();
  if (observed && (!observed.ok || observed.type !== "userProfiles.email.resolve")) {
    throw new Error("Unexpected profile email lookup reply");
  }
  if (observed?.profileId) {
    return observed.profileId;
  }
  const { ensureCanonicalUserProfileForEmail } = await import("./user-profile-writes.js");
  const profile = await ensureCanonicalUserProfileForEmail(normalized, {
    ...selected,
    assertCurrent: () => {
      context.admission.assertCurrent();
      assertCurrent?.();
    },
  });
  return profile.id;
}
