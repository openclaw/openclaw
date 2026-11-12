import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import type { OpenClawIdUserProfiles } from "./user-profile-openclaw-id.types.js";

export { ensureCanonicalUserProfileForOpenClawIdIdentity } from "./user-profile-writes.js";

/** Reads display metadata and canonical references only; callers retain all access decisions. */
export async function readOpenClawIdUserProfiles(
  accountIds: readonly string[],
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> = {},
): Promise<OpenClawIdUserProfiles> {
  if (!accountIds.length) {
    return {};
  }
  const reply = await executeExistingOpenClawStateRead(
    options,
    { type: "userProfiles.openClawId.read", input: { accountIds: [...accountIds] } },
    { current: true },
  );
  return reply?.profiles ?? {};
}
