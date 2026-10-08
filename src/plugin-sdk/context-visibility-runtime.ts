// Narrow context visibility helpers without broad config-runtime imports.

export { resolveChannelContextVisibilityMode } from "../config/context-visibility.js";
export {
  evaluateSupplementalContextVisibility,
  filterSupplementalContextItems,
  shouldIncludeSupplementalContext,
  type ContextVisibilityDecisionReason,
  type ContextVisibilityKind,
} from "../security/context-visibility.js";
