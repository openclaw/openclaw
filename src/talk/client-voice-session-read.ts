import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { withSessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker-runtime.js";
import { resolveStateDir } from "../config/state-dir.js";
import type { OpenClawAgentDatabaseOptions } from "../state/openclaw-agent-db-contract.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import type { VoiceSessionLookup, VoiceSessionMatch } from "./client-voice-session-store.js";

/** Use the existing agent reader's custody and revocation lifecycle. */
export async function lookupClientVoiceSessions(
  request: VoiceSessionLookup,
  source?: Pick<OpenClawAgentDatabaseOptions, "env" | "path">,
): Promise<VoiceSessionMatch[]> {
  const env = cloneEnvWithPlatformSemantics(source?.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const options = {
    agentId: request.agentId,
    env,
    path: resolveOpenClawAgentSqlitePath({ agentId: request.agentId, env, path: source?.path }),
  };
  return withSessionHistoryWorkerDatabase(options, async (owner) => {
    const result = await owner.readVoiceSessions({ request, env });
    owner.assertCurrent();
    return result.matches;
  });
}
