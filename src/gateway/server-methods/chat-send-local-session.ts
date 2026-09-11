// chat.send for a live local session: no Gateway run, the device bridge relays
// the message and the caller gets a typed receipt whose later transitions arrive
// as `session.localInput` events.
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { LOCAL_SESSION_RECORD_TEXT_MAX_BYTES } from "../../sessions/local-session-source-protocol.js";
import { getLocalSessionBridge } from "../local-sessions/bridge.js";
import { resolveGatewayInputParticipant } from "../session-input-participant.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export async function handleLocalSessionChatSend(params: {
  request: NormalizedChatSendRequest;
  session: PreparedChatSendSession;
  respond: GatewayRequestHandlerOptions["respond"];
  client: GatewayRequestHandlerOptions["client"];
}): Promise<void> {
  const { request, session, respond, client } = params;
  const { entry, sessionKey, agentId, storePath, clientRunId } = session;
  const bridge = getLocalSessionBridge();
  if (!entry || !bridge) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, "Live local sessions are unavailable on this Gateway."),
    );
    return;
  }
  const text = request.rawMessage.trim();
  if (!text) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "message is required"));
    return;
  }
  // The device decoder enforces the same bound; a frame it rejects would be a
  // channel fault, not a per-message outcome, so refuse here with a plain error.
  if (Buffer.byteLength(text, "utf8") > LOCAL_SESSION_RECORD_TEXT_MAX_BYTES) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `Messages into a live local session are limited to ${Math.floor(LOCAL_SESSION_RECORD_TEXT_MAX_BYTES / 1024)} KiB; shorten it or attach the text as a file on the device.`,
      ),
    );
    return;
  }
  if (request.normalizedAttachments.length > 0) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Attachments cannot be sent into a live local session yet; send text only.",
      ),
    );
    return;
  }
  const requestedMode = request.p.queueMode;
  if (requestedMode !== undefined && requestedMode !== "steer" && requestedMode !== "followup") {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `Queue mode "${requestedMode}" is not supported for live local sessions; use steer or followup.`,
      ),
    );
    return;
  }
  // No explicit mode: steer when the source can, else follow up (Claude Code
  // sources only queue). A wrong default would reject every plain message.
  const inputModes = bridge.getStatus(sessionKey)?.inputModes ?? [];
  const mode = requestedMode ?? (inputModes.includes("steer") ? "steer" : "followup");
  const profile = client?.authenticatedUserProfile;
  const receipt = await bridge.submitInput({
    entry,
    sessionKey,
    agentId,
    storePath,
    inputId: clientRunId,
    text,
    mode,
    sender: {
      ...(profile?.profileId ? { profileId: profile.profileId } : {}),
      displayName: profile?.displayName?.trim() || "Teammate",
    },
    participant: resolveGatewayInputParticipant(client),
  });
  if (receipt.state === "rejected") {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        receipt.reason ?? "The device did not accept the message.",
        {
          details: { inputId: receipt.inputId },
        },
      ),
    );
    return;
  }
  respond(true, { runId: clientRunId, status: "submitted", localInput: receipt }, undefined, {
    runId: clientRunId,
  });
}
