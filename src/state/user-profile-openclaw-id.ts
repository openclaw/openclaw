import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import type { OpenClawIdUserProfiles } from "./user-profile-openclaw-id.types.js";

export {
  ensureCanonicalUserProfileForOpenClawIdIdentity,
  linkCanonicalOpenClawIdUserProfile,
  unlinkCanonicalOpenClawIdUserProfile,
} from "./user-profile-writes.js";

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

/** The profile an OCID account is linked to, or null; attribution only, never access. */
export async function readOpenClawIdLinkedProfile(
  accountId: string,
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> = {},
): Promise<{ profileId: string; updatedAt: number } | null> {
  const reply = await executeExistingOpenClawStateRead(
    options,
    { type: "userProfiles.openClawId.linkedProfile", input: { accountId } },
    { current: true },
  );
  return reply?.profile ?? null;
}

/** The OCID accounts linked to a profile (several after a merge), oldest first. */
export async function readOpenClawIdLinksOfProfile(
  profileId: string,
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> = {},
): Promise<Array<{ accountId: string; email: string | null }>> {
  const reply = await executeExistingOpenClawStateRead(
    options,
    { type: "userProfiles.openClawId.linksOf", input: { profileId } },
    { current: true },
  );
  return reply?.links ?? [];
}
