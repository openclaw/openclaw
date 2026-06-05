/**
 * Runtime SDK subpath for skill snapshot invalidation and refresh listeners.
 */
export {
  bumpSkillsSnapshotVersion,
  getSkillsSnapshotVersion,
  registerSkillsChangeListener,
  shouldRefreshSnapshotForVersion,
  type SkillsChangeEvent,
} from "../skills/runtime/refresh-state.js";

export {
  registerSkillRouter,
  resolveSkillRouter,
  listRegisteredSkillRouters,
} from "../skills/loading/router-registry.js";

export type {
  SkillRouteContext,
  SkillRouteContextMessage,
  SkillRouteResult,
  SkillRouter,
} from "../skills/loading/router-types.js";
export type { SkillForPrompt } from "../skills/loading/skill-contract.js";
