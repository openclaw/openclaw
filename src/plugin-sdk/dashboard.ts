/** Manifest-declared dashboard bindings borrow exact Board authority, never raw Gateway callers. */
export { captureDashboardDataBindingRead } from "../plugins/dashboard-data-binding-scope.js";
export type {
  PluginDashboardDataBindingV1,
  PluginDashboardDataBindingHost,
  PreparedPluginDashboardDataBinding,
} from "../plugins/dashboard-data-binding.types.js";

export { BoardValidationError } from "../boards/board-errors.js";
export { BoardGatewayUnavailableError } from "../boards/board-errors.js";

// Native persisted grant compatibility; request construction remains plugin-owned.
export {
  GITHUB_ACTIONS_BINDING_ID,
  GITHUB_ACTIONS_GRANT_PREFIX,
  GitHubActionsRepositorySchema,
  normalizeGitHubActionsGrant,
} from "../boards/legacy-github-actions-grant.js";
