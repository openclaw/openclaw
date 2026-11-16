import { operatorScopeSatisfied } from "../../../../src/shared/operator-scope-compat.js";
import type { CronJob } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { readGatewayOperatorAccess } from "../../app/operator-access.ts";
import { profileDirectory } from "../../lib/profile-directory.ts";

export function canManageCronJob(gateway: ApplicationContext["gateway"], job: CronJob): boolean {
  const snapshot = gateway.snapshot;
  if (readGatewayOperatorAccess(snapshot).canAdmin) {
    return true;
  }
  const identity = snapshot.selfUser?.identity;
  const ownerId = job.ownerProfileId;
  const directory = profileDirectory(gateway);
  return Boolean(
    ownerId &&
    identity?.type === "profile" &&
    (directory.get(ownerId)?.id ?? ownerId) === identity.id &&
    operatorScopeSatisfied("operator.cron", snapshot.hello?.auth?.scopes ?? []),
  );
}
