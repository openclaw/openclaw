import { GITHUB_ACTIONS_BINDING_ID } from "./legacy-github-actions-grant.js";

export const CORE_BOARD_DATA_BINDING_IDS = [
  "sessions.list",
  "usage.status",
  "usage.cost",
  "cron.list",
  "cron.status",
  "agents.list",
  "health",
] as const;

/** Persisted pre-plugin names remain reserved even while their owner is disabled. */
export const LEGACY_BOARD_DATA_BINDING_IDS = [GITHUB_ACTIONS_BINDING_ID] as const;

const CORE_BOARD_ACTION_VERB_IDS = ["cron.trigger"] as const;

/** Widget grants share one string namespace across reads and actions. */
export const CORE_BOARD_HOST_CAPABILITY_IDS = [
  ...CORE_BOARD_DATA_BINDING_IDS,
  ...CORE_BOARD_ACTION_VERB_IDS,
] as const;
