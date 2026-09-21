import { createHash } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ErrorCodes,
  errorShape,
  type ProgressCard,
} from "../../../packages/gateway-protocol/src/index.js";
import { PROGRESS_CARD_REFRESH_SOURCE_TOOL } from "../../sessions/input-provenance.js";
import { handleTrustedInternalChatSend } from "./chat-send-handler.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const REFRESH_MESSAGE = [
  "Refresh this session’s progress card now using progress_card.",
  "Reconcile the latest conversation and current work: completed work, remaining steps, blockers, and next action. Replace stale scope and statuses; do not merely repeat the previous card or update its timestamp.",
  "Use only quick read-only checks if needed. State what is unverified rather than inventing progress. If nothing changed, confirm the current state with a fresh card write.",
  "This is a status request, not authorization to resume stopped or idle work, start new work, or change the task goal.",
  "Do not acknowledge this request or send a chat reply. The updated card is the response. After updating it, continue work only if it was already active.",
].join("\n");

/** Reuse chat admission/steering with the original principal, never an elevated synthetic client. */
export async function requestProgressCardRefresh(
  invocation: GatewayRequestHandlerOptions,
  target: { sessionKey: string; agentId: string },
  card: ProgressCard,
  idempotencyKey: string,
): Promise<void> {
  const runId = `progress-card-refresh:${createHash("sha256")
    .update(JSON.stringify([target.agentId, target.sessionKey, idempotencyKey]))
    .digest("hex")}`;
  const receiptKey = `progressCard.refresh:${runId}`;
  await handleTrustedInternalChatSend(
    {
      ...invocation,
      req: { ...invocation.req, method: "chat.send" },
      params: {
        sessionKey: target.sessionKey,
        agentId: target.agentId,
        message: REFRESH_MESSAGE,
        idempotencyKey: runId,
        queueMode: "steer",
        deliver: false,
        suppressCommandInterpretation: true,
        systemInputProvenance: {
          kind: "internal_system",
          sourceTool: PROGRESS_CARD_REFRESH_SOURCE_TOOL,
        },
      },
      respond: (ok, payload, error, meta) => {
        const result = asOptionalRecord(payload);
        // A lost ACK can be retried after the new card is already written. Keep
        // the original baseline in the existing bounded Gateway dedupe owner.
        const receipt = asOptionalRecord(invocation.context.dedupe.get(receiptKey)?.payload);
        const revision = typeof receipt?.revision === "number" ? receipt.revision : card.revision;
        const terminalFailure =
          (result?.status === "completed" && card.revision <= revision) ||
          result?.status === "error" ||
          result?.status === "timeout" ||
          result?.status === "aborted";
        if (!ok || terminalFailure) {
          invocation.respond(
            false,
            undefined,
            terminalFailure
              ? errorShape(
                  ErrorCodes.UNAVAILABLE,
                  "The agent could not refresh this card. Retry the refresh.",
                  { details: { code: "PROGRESS_CARD_REFRESH_TERMINAL" } },
                )
              : (error ??
                  errorShape(
                    ErrorCodes.UNAVAILABLE,
                    "The agent could not refresh this card. Retry the refresh.",
                  )),
            meta,
          );
          return;
        }
        const accepted = { runId, status: "accepted", revision };
        invocation.context.dedupe.set(receiptKey, { ts: Date.now(), ok: true, payload: accepted });
        invocation.respond(true, accepted, undefined, meta);
      },
    },
    undefined,
    {
      transcript: { display: false },
      // Active steering inherits the current turn’s tools; a standalone refresh cannot resume work.
      toolsAllow: [
        "progress_card",
        "read",
        "sessions_history",
        "sessions_list",
        "session_status",
        "memory_search",
        "memory_get",
      ],
      prepareAssistantTranscriptMessage: (message) => ({ ...message, display: false }),
    },
  );
}
