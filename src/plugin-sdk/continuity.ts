// Narrow plugin-sdk surface for the bundled continuity plugin.

export type { OpenClawPluginApi } from "../plugins/types.js";
export type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
export { ErrorCodes, errorShape } from "../gateway/protocol/schema/error-codes.js";
export {
  ContinuityContextEngine,
  createContinuityService,
  registerContinuityCli,
  resolveContinuityConfig,
} from "../continuity/index.js";
export type {
  ContinuityExplainResult,
  ContinuityKind,
  ContinuityListFilters,
  ContinuityPatchAction,
  ContinuityPatchResult,
  ContinuityPluginConfig,
  ContinuityRecord,
  ContinuityReviewState,
  ContinuitySourceClass,
  ContinuityStatus,
  ContinuityService,
} from "../continuity/index.js";
