import { randomUUID } from "node:crypto";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import { captureRequesterOrigin } from "../../agents/requester-origin.js";
import { prepareCommandTranscriptInput } from "../../config/sessions/command-transcript.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getGatewayLocalUserIngress } from "../../gateway/local-user-ingress.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { buildChannelUserTurnSender } from "../../sessions/user-turn-transcript.metadata.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { getCommandOwnerAuthority } from "../command-owner-authority.js";
import type { FinalizedMsgContext } from "../templating.js";
import { normalizeMessageTimestampMs } from "./message-timestamp.js";
import { resolveInboundReplyToolAuthorityOverlay } from "./reply-tool-authority-inbound.js";
import { readChannelSourceTurnId } from "./source-turn-id.js";

/** The run identity and input recorder of one live command turn. */
export type CommandUserTurn = Readonly<{
  runId: string;
  userTurnTranscriptRecorder: UserTurnTranscriptRecorder;
}>;

// One turn per dispatch, so a re-entered command reuses its committed input.
const channelTurns = new WeakMap<object, CommandUserTurn>();

/**
 * Gateway chat ingress supplies its own run and recorder. Channel ingress has neither,
 * so the host mints them here, but only for the operator authority that host ingress
 * bound to this verified channel principal. Nothing persists until the gate commits it.
 */
export async function prepareChannelCommandUserTurn(params: {
  dispatch: object;
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  replyOptions:
    | {
        runId?: string;
        userTurnTranscriptRecorder?: UserTurnTranscriptRecorder;
        operatorAuthority?: AdmittedRunOperatorAuthority;
      }
    | undefined;
  binding: {
    agentId: string;
    sessionKey: string;
    entry: SessionEntry;
    storePath?: string;
    commandBody?: string;
  };
}): Promise<CommandUserTurn | undefined> {
  const { ctx, replyOptions, binding } = params;
  const operatorAuthority = replyOptions?.operatorAuthority;
  const ownerAuthority = getCommandOwnerAuthority(ctx);
  if (
    replyOptions?.runId !== undefined ||
    replyOptions?.userTurnTranscriptRecorder !== undefined ||
    getGatewayLocalUserIngress(ctx) !== undefined ||
    isInternalMessageChannel(ctx.Provider ?? ctx.Surface) ||
    !operatorAuthority ||
    !ownerAuthority ||
    ownerAuthority.operatorAuthority !== operatorAuthority ||
    !binding.entry.sessionId ||
    !binding.storePath ||
    !binding.commandBody
  ) {
    return undefined;
  }
  const existing = channelTurns.get(params.dispatch);
  if (existing) {
    return existing;
  }
  // Store the same redacted form the channel command transcript already records.
  const text = await prepareCommandTranscriptInput(binding.commandBody);
  if (!text) {
    return undefined;
  }
  const raced = channelTurns.get(params.dispatch);
  if (raced) {
    return raced;
  }
  const senderIsOwner = ownerAuthority.isCurrent();
  const timestamp = normalizeMessageTimestampMs(ctx.Timestamp);
  // Dispatch fixed this route-scoped id before hooks; a continuing agent turn and restart
  // recovery require the same source-keyed admission.
  const sourceTurnId = readChannelSourceTurnId(ctx);
  const persistSender =
    ctx.ChatType === "group" ||
    ctx.ChatType === "channel" ||
    (ctx.InboundAccessAuthorized === true && ctx.SenderIsSelf !== true);
  const turn: CommandUserTurn = Object.freeze({
    runId: randomUUID(),
    userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
      input: {
        text,
        senderIsOwner,
        requesterOrigin: captureRequesterOrigin({
          ...resolveInboundReplyToolAuthorityOverlay({
            ctx,
            sessionEntry: binding.entry,
            senderIsOwner,
            operatorAuthority,
            disableTools: false,
          }),
          sessionKey: binding.sessionKey,
          operatorProfileId: operatorAuthority.profileId,
        }),
        ...(sourceTurnId ? { idempotencyKey: sourceTurnId } : {}),
        ...(ctx.InputProvenance ? { provenance: ctx.InputProvenance } : {}),
        ...(timestamp ? { timestamp } : {}),
        ...(persistSender ? { sender: buildChannelUserTurnSender(ctx) } : {}),
      },
      target: {
        agentId: binding.agentId,
        sessionKey: binding.sessionKey,
        sessionId: binding.entry.sessionId,
        sessionEntry: binding.entry,
        storePath: binding.storePath,
        config: params.cfg,
      },
      errorContext: "plugin command user turn transcript",
      beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
    }),
  });
  channelTurns.set(params.dispatch, turn);
  return turn;
}

/** Delivered-command mirror fields: a committed native command turn already holds the input. */
export function commandTranscriptMirror(dispatch: object, commandText: string, commandId: string) {
  return channelTurns.get(dispatch)?.userTurnTranscriptRecorder.getAdmissionReceipt()
    ? { commandText, commandId, commandInputCommitted: true }
    : { commandText, commandId };
}
