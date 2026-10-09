import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/state-dir.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
  type DatabaseFileIdentity,
} from "../infra/sqlite-worker-identity.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import { borrowOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  assertClientVoiceSessionSettlementCurrent,
  captureClientVoiceSessionSettlementContext,
} from "./client-voice-session-lifecycle.js";

/** Voice metadata stays bound to its admitted physical store across provider and queue waits. */
function sourceOptions(agentId: string) {
  const env = cloneEnvWithPlatformSemantics(process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const path = resolveOpenClawAgentSqlitePath({ agentId, env });
  return { agentId, env, path };
}

function capturedSource(options: ReturnType<typeof sourceOptions>, identity: DatabaseFileIdentity) {
  const settlementContext = captureClientVoiceSessionSettlementContext(options.env);
  return {
    options,
    identity,
    settlementContext,
    assertCurrent() {
      assertClientVoiceSessionSettlementCurrent(settlementContext);
      settlementContext.admission.assertCurrent();
      assertExistingDatabaseIdentity(options.path, identity.key, identity.birthtime);
    },
  };
}

export function captureClientVoiceSessionSource(agentId: string) {
  const options = sourceOptions(agentId);
  return capturedSource(options, readDatabasePathIdentitySync(options.path));
}

/** A silent relay can reach provider close before its lazy metadata store exists. */
export function borrowClientVoiceSessionSource(agentId: string) {
  const options = sourceOptions(agentId);
  const existing = readDatabasePathIdentitySync(options.path);
  if (existing.key.startsWith("file:")) {
    return { source: capturedSource(options, existing), release() {} };
  }
  const borrowed = borrowOpenClawAgentDatabase(options);
  try {
    const { identity, birthtime } = readOpenClawAgentDatabaseIdentity(borrowed);
    const source = capturedSource(options, { key: `file:${String(identity)}`, birthtime });
    source.assertCurrent();
    return { source, release: borrowed.release };
  } catch (error) {
    borrowed.release();
    throw error;
  }
}

export type ClientVoiceSessionSource = ReturnType<typeof captureClientVoiceSessionSource>;
