import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { normalizeAgentId } from "../routing/session-key.js";

export const CONTINUITY_ROLLUP_BASENAME = "ROLLUP.md";

export function resolveContinuityRollupPath(
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const stateDir = resolveStateDir(env, homedir);
  const normalizedAgentId = normalizeAgentId(agentId);
  return path.join(stateDir, "agents", normalizedAgentId, "continuity", CONTINUITY_ROLLUP_BASENAME);
}
