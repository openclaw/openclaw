import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { StartChatDispatchParams } from "./chat-send-agent-dispatch.types.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { publishCommittedSessionGoalChange } from "./session-goal-change.js";
import type { RespondFn } from "./types.js";

/** Dispatch owns cleanup; a lost ACK reconciles through the durable Goal receipt. */
export async function acknowledgeCodexGoal(params: {
  dispatch: StartChatDispatchParams;
  committed: Promise<void>;
  dispatched: Promise<void>;
  ackPayload: { runId: string; status: "started" };
  respond: RespondFn;
}): Promise<void> {
  const { context, session, request, client, userTurn } = params.dispatch;
  try {
    await Promise.race([params.committed, params.dispatched]);
    const persisted = userTurn.recorder.hasPersisted() ? await userTurn.persist() : undefined;
    const result = persisted?.sessionTurnMutationResult?.result;
    if (!result || !persisted?.sessionEntry || !request.goalOperation) {
      throw new Error("Codex Goal input was not committed; inspect the run before retrying.");
    }
    await publishCommittedSessionGoalChange(context, {
      sessionKey: session.sessionKey,
      agentId: session.agentId,
      entry: persisted.sessionEntry,
      actor: gatewayClientSessionCreator(client),
      summary: `goal ${request.goalOperation.action}`,
    });
    params.respond(true, { ...params.ackPayload, ...result }, undefined, {
      runId: session.clientRunId,
    });
  } catch (error) {
    if (!userTurn.recorder.hasPersisted() && request.goalOperation) {
      // Dispatch settled before admission: keep the input binding, not its terminal response.
      context.dedupe.set(`chat:${session.clientRunId}`, {
        ts: Date.now(),
        ok: true,
        requestIdentity: request.goalOperation.requestFingerprint,
      });
    }
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, String(error), { retryable: true }),
    );
  }
}
