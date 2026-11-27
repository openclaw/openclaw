import { DEFAULT_ACCOUNT_ID } from "../routing/account-id.js";
import type { CronJob } from "./types.js";

/** Routing, a display name, or management access is not ownership of a declaration. */
export function cronDeclarationOwnedBy(
  job: Pick<CronJob, "owner">,
  owner: { agentId: string; sessionKey: string; accountId?: string },
): boolean {
  return (
    job.owner?.agentId === owner.agentId &&
    job.owner.sessionKey === owner.sessionKey &&
    (job.owner.accountId ?? DEFAULT_ACCOUNT_ID) === (owner.accountId ?? DEFAULT_ACCOUNT_ID)
  );
}
