import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";

const replacements = {
  confirmPersonal: "confirmPersonalV2",
  deferClaimPreparation: "deferClaimPreparationAsync",
  deferOrphanedRequests: "deferOrphanedRequestsAsync",
  listUnreportedResults: "listUnreportedResultsAsync",
  markReported: "markReportedAsync",
  "personal.cancelAuthorization": "personal.cancelAuthorizationAsync",
  "personal.disconnect": "personal.disconnectAsync",
  personalStatus: "personalStatusAsync",
  requestForClaim: "requestForClaimV2",
  requestForSession: "requestForSessionV2",
  requestPersonalForSession: "requestPersonalForSessionV2",
} as const;

/** Keep the shared publication compatibility family and replacement pairs in one place. */
export function warnGitHubPublicationDeprecation(method: keyof typeof replacements): void {
  warnPluginSdkDeprecation({
    family: "github-publication",
    method,
    replacement: replacements[method],
  });
}
