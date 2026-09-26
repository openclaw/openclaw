import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  mergeCronListVisibility,
  type CronListPageResult,
} from "../../cron/service/list-page-types.js";
import { resolveCronSessionTargetSessionKey } from "../../cron/session-target.js";
import type { CronJob } from "../../cron/types.js";
import { getCronManagementAuthority } from "../cron-creator-authority-grant.js";
import { operatorSessionCap } from "../operator-role-policy.js";
import { createSessionListEntryFilter } from "../session-sharing.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import type { GatewayClient } from "./types.js";

export type { CronListPageResult } from "../../cron/service/list-page-types.js";

type CronSessionVisibility = (sessionKey: string, agentId?: string) => boolean;

const CRON_ROLE_RESTRICTION_WARNING =
  "Automation list is restricted by the calling operator role's session visibility policy. Inaccessible automations are omitted; total, pagination, and snapshotRevision describe this restricted view, not the complete Gateway inventory.";

export function resolveCronSessionVisibility(
  client: GatewayClient | null,
  cfg: OpenClawConfig,
): CronSessionVisibility | undefined {
  const identity = client?.internal?.agentRuntimeIdentity;
  if (identity && getCronManagementAuthority(identity)) {
    return undefined;
  }
  if (operatorSessionCap(client, cfg) !== "none") {
    return undefined;
  }
  const entryFilter = createSessionListEntryFilter({ client, cfg });
  if (!entryFilter) {
    return undefined;
  }
  return (sessionKey, agentId) => {
    const loaded = loadGatewaySessionEntryReadOnly(sessionKey, agentId ? { agentId } : undefined);
    return loaded.entry !== undefined && entryFilter(loaded.canonicalKey, loaded.entry);
  };
}

export function cronJobIsVisible(
  job: CronJob,
  visibility: CronSessionVisibility | undefined,
  defaultAgentId: string | undefined,
): boolean {
  if (!visibility) {
    return true;
  }
  const sessionKey =
    job.owner?.sessionKey ??
    resolveCronSessionTargetSessionKey(job.sessionTarget) ??
    job.sessionKey;
  return Boolean(
    sessionKey && visibility(sessionKey, job.owner?.agentId ?? job.agentId ?? defaultAgentId),
  );
}

/** Adds disclosure metadata after caller and role filters have produced the page. */
export function applyCronListVisibility(
  page: CronListPageResult,
  scope: { callerScoped: boolean; roleRestricted: boolean },
): CronListPageResult {
  if (!scope.callerScoped && !scope.roleRestricted) {
    return page;
  }
  let visibility = page.visibility;
  if (scope.callerScoped) {
    visibility = mergeCronListVisibility(visibility, {
      mode: "caller",
      warning:
        "Automation list is restricted to automations visible to the calling agent. Inaccessible automations are omitted; total, pagination, and snapshotRevision describe this restricted view, not the complete Gateway inventory.",
    });
  }
  if (scope.roleRestricted) {
    visibility = scope.callerScoped
      ? mergeCronListVisibility(visibility, {
          mode: "role",
          warning: `${CRON_ROLE_RESTRICTION_WARNING} The calling operator role also restricts session visibility; the result is narrowed by both policies.`,
        })
      : {
          mode: "role",
          restricted: true,
          warning: CRON_ROLE_RESTRICTION_WARNING,
        };
  }
  return { ...page, visibility };
}
