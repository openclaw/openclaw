// Durable workflow feature flag and path resolution.
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

export function isDurableWorkflowsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ENABLED_VALUES.has((env.OPENCLAW_DURABLE_WORKFLOWS ?? "").trim().toLowerCase());
}

export function resolveDurableWorkflowSqlitePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveOpenClawStateSqlitePath(env);
}
