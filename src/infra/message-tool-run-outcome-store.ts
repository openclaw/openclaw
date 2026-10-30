import { withSessionActorStorage } from "../config/sessions/session-actor-storage-acquisition.js";
import {
  captureSessionActorStorageOwner,
  type SessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import { readSessionActorStorageResult } from "../config/sessions/session-actor-storage-result.js";
import { IncognitoSessionMissingError } from "../state/incognito-session-error.js";
import type { MessageToolRunOutcomeInsert } from "./message-tool-run-outcome-store.kernel.js";

/** Keeps incognito side data; durable diagnostic outcomes have no reader. */
export async function recordMessageToolRunOutcome(params: {
  runId: string;
  sessionKey: string;
  agentId: string;
  provider: string;
  model: string;
  outcome: "tool_delivered" | "mute";
  runStatus: "completed" | "errored" | "aborted";
  occurredAt: number;
  storePath?: string;
  env?: NodeJS.ProcessEnv;
  sessionActor?: SessionActorStorageBinding;
}): Promise<boolean> {
  const authority = { assertCurrent() {}, authorize() {} };
  const memory = captureSessionActorStorageOwner(params, authority);
  if (!memory) {
    return false;
  }
  const values: MessageToolRunOutcomeInsert = {
    run_id: params.runId,
    session_key: params.sessionKey,
    agent_id: params.agentId,
    provider: params.provider,
    model: params.model,
    outcome: params.outcome,
    run_status: params.runStatus,
    occurred_at: params.occurredAt,
  };
  const recorded = await withSessionActorStorage(
    params,
    {
      authority,
      lifetime: {
        assertCurrent: () => authority.assertCurrent(),
        assertReadable: () => authority.assertCurrent(),
      },
    },
    async ({ actor, authority: selectedAuthority }) => {
      const result = await actor.storage.mutate(
        { type: "session.messageToolOutcome.record", input: values },
        selectedAuthority,
      );
      readSessionActorStorageResult(result);
      return true;
    },
  );
  // Closing an incognito session discards late bookkeeping; the run owner records the warning.
  if (!recorded) {
    throw new IncognitoSessionMissingError();
  }
  return true;
}
