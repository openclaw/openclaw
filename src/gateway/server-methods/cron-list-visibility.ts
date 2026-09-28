import {
  mergeCronListVisibility,
  type CronListPageResult,
} from "../../cron/service/list-page-types.js";

export type { CronListPageResult } from "../../cron/service/list-page-types.js";

const CRON_ROLE_RESTRICTION_WARNING =
  "Automation list is restricted by the calling operator role's session visibility policy. Inaccessible automations are omitted; total, pagination, and snapshotRevision describe this restricted view, not the complete Gateway inventory.";

/** Adds disclosure metadata after caller and role filters have produced the page. */
function applyCronListVisibility(
  page: CronListPageResult,
  scope: { callerScoped: boolean; roleRestricted: boolean; includeVisibility: boolean },
): CronListPageResult {
  if (!scope.includeVisibility || (!scope.callerScoped && !scope.roleRestricted)) {
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

/** Marks a page only after its request-scoped list query has completed. */
export function markCronListPage(
  page: Promise<CronListPageResult>,
  options: {
    callerScoped: boolean;
    roleRestricted: boolean;
    includeVisibility: boolean;
    afterRead?: () => void;
  },
): Promise<CronListPageResult> {
  return page.finally(options.afterRead).then((result) => applyCronListVisibility(result, options));
}
