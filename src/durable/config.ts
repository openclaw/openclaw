// Durable workflow feature flag and path resolution.
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

export function isDurableWorkflowsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ENABLED_VALUES.has((env.OPENCLAW_DURABLE_WORKFLOWS ?? "").trim().toLowerCase());
}

export function resolveDurableWorkflowSqlitePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCLAW_DURABLE_WORKFLOWS_DB_PATH?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(resolveStateDir(env), "durable", "workflows.sqlite");
}
