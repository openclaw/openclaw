import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsCreateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import type { CreatedGatewaySession } from "../session-create-service.types.js";
import {
  normalizeRpcAttachmentsToChatAttachments,
  type RpcAttachmentInput,
} from "./attachment-normalize.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import type { prepareSessionCreateOpening } from "./session-create-spawn.js";
import { bindGatewayRequestHandlerMutationAuthority } from "./session-mutation-guards.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./types.js";

const loadChatSendInternalEntry = createLazyRuntimeModule(() => import("./chat-send-handler.js"));
const loadChatSendExternalEntry = createLazyRuntimeModule(
  () => import("./chat-send-external-entry.js"),
);

export function resolveSessionCreateInitialTurn(params: {
  attachments?: unknown[];
  message?: unknown;
  task?: unknown;
}) {
  const message = readNonBlankString(params.task) ?? readNonBlankString(params.message);
  const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(
    params.attachments as RpcAttachmentInput[] | undefined,
  );
  if (params.attachments?.length && !message && normalizedAttachments.length === 0) {
    return null;
  }
  const attachments = normalizedAttachments.length ? normalizedAttachments : undefined;
  return {
    attachments,
    hasInitialTurn: message !== undefined || attachments !== undefined,
    message,
  };
}

export async function dispatchSessionCreateInitialTurn(
  options: GatewayRequestHandlerOptions,
  params: {
    opening: ReturnType<typeof prepareSessionCreateOpening>;
    session: Pick<CreatedGatewaySession, "key" | "agentId">;
    initialTurn: NonNullable<ReturnType<typeof resolveSessionCreateInitialTurn>>;
    request: Pick<SessionsCreateParams, "timeoutMs" | "mentions">;
    runId: string;
    assertCurrent: () => void;
    respond: GatewayRequestHandlerOptions["respond"];
  },
): Promise<void> {
  const { opening, session, initialTurn, request } = params;
  const sendOptions = bindGatewayRequestHandlerMutationAuthority(
    options,
    {
      ...options,
      client: opening.client,
      params: {
        sessionKey: session.key,
        agentId: session.agentId,
        message: initialTurn.message ?? "",
        idempotencyKey: params.runId,
        ...opening.internalInput,
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        ...(request.mentions ? { mentions: request.mentions } : {}),
        ...(initialTurn.attachments ? { attachments: initialTurn.attachments } : {}),
      },
      respond: params.respond,
    },
    undefined,
  );
  params.assertCurrent();
  // The initial turn must acquire its own writer, not the requesting session's.
  await runWithoutOwnedSessionTranscriptWrites(async () => {
    if (opening.internalInput) {
      const { handleTrustedInternalChatSend } = await loadChatSendInternalEntry();
      await handleTrustedInternalChatSend(sendOptions, undefined, { stageCreatedInput: true });
    } else {
      const { handleDirectExternalChatSend } = await loadChatSendExternalEntry();
      await handleDirectExternalChatSend(sendOptions);
    }
  });
}

export function isFreshChatSendStarted(params: { cached?: boolean; payload: unknown }): boolean {
  if (params.cached) {
    return false;
  }
  const status =
    params.payload && typeof params.payload === "object"
      ? (params.payload as { status?: unknown }).status
      : undefined;
  return status === "started";
}

/** Validate the initial turn against the same child identity used by creation. */
export async function validateSessionCreateInitialMentions(params: {
  client: GatewayClient | null;
  context: GatewayRequestContext;
  agentId: string;
  sessionKey: string;
  message?: string;
  mentions: NonNullable<SessionsCreateParams["mentions"]>;
  visibility: SessionsCreateParams["visibility"];
  runId: string;
}): Promise<ErrorShape | undefined> {
  const { client, context, agentId, sessionKey, message, mentions, visibility, runId } = params;
  const normalization = normalizeChatSendRequest({
    params: {
      sessionKey,
      message: message ?? "",
      mentions,
      idempotencyKey: runId,
    },
    client,
  });
  const normalized = normalization instanceof Promise ? await normalization : normalization;
  if (!normalized.ok) {
    return errorShape(ErrorCodes.INVALID_REQUEST, normalized.error);
  }
  const eligible = await context.mentionInbox?.validateRecipientsAsync(
    client,
    { agentId, ...(visibility ? { visibility } : {}) },
    mentions.map((mention) => mention.profileId),
  );
  if (!eligible?.ok) {
    return (
      eligible?.error ??
      errorShape(ErrorCodes.UNAVAILABLE, "Human mentions are unavailable; reconnect and retry.")
    );
  }
  return undefined;
}
