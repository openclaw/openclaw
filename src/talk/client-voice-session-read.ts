import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { withSessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker-runtime.js";
import { resolveStateDir } from "../config/state-dir.js";
import type { OpenClawAgentDatabaseOptions } from "../state/openclaw-agent-db-contract.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { withClientVoiceSessionResources } from "./client-voice-session-lifecycle.js";
import type { ClientVoiceSessionSource } from "./client-voice-session-source.js";
import {
  assertVoiceSessionOwnership,
  type ClientVoiceRunBinding,
  type VoiceSessionLookup,
  type VoiceSessionMatch,
} from "./client-voice-session-store.js";
import { captureClientVoiceSessionWriter } from "./client-voice-session-write.js";

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

/** Read the canonical agent-session id without creating state during provider startup. */
export async function resolveClientVoiceAgentSessionId(params: {
  agentId: string;
  sessionKey: string;
  storePath?: string;
}): Promise<string | undefined> {
  return (await readSessionEntryReadOnlyInWorker(params))?.sessionId?.trim() || undefined;
}

/** Resolve the unique open client-owned call for legacy tool-call clients. */
export async function resolveOpenClientVoiceSessionId(
  params: { agentId: string; sessionKey: string },
  source?: Pick<OpenClawAgentDatabaseOptions, "env" | "path">,
): Promise<string | undefined> {
  const matches = await lookupClientVoiceSessions({ kind: "legacy", ...params }, source);
  return matches.length === 1 ? matches[0]?.voiceSessionId : undefined;
}

/** Validate ownership and open state before starting a voice-bound consult. */
export async function assertClientVoiceSessionOpen(
  params: ClientVoiceRunBinding,
  source?: ClientVoiceSessionSource,
): Promise<"client" | "relay"> {
  source?.assertCurrent();
  const writer = captureClientVoiceSessionWriter({
    agentId: params.agentId,
    physicalSource: source,
  });
  const read = await withClientVoiceSessionResources([writer], () =>
    writer.read(params.voiceSessionId),
  );
  source?.assertCurrent();
  if (!read?.record) {
    throw new Error("voice session not found");
  }
  assertVoiceSessionOwnership(read.record, params);
  if (read.record.status !== "open") {
    throw new Error("voice session is closed");
  }
  return read.record.origin;
}
