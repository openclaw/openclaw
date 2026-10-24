import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import type { ChatPendingInputsPage } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import {
  listSessionPendingInputs,
  type SessionPendingInput,
} from "../../config/sessions/session-accessor.js";
import {
  getRpcSourceIdentity,
  isRpcSourceQueued,
  listRpcSourceEntries,
} from "../../sessions/session-controller.rpc-sources.js";
import { prepareForwardedMessageCronJobNameResolver } from "../chat-display-projection.history.js";
import {
  createCurrentUserProfileMessageProjector,
  projectChatDisplayMessage,
} from "../chat-display-projection.js";
import { replaceOversizedChatHistoryMessages } from "../chat-history-budget.js";
import { resolveCurrentUserProfileDisplay } from "../current-user-profile-display.js";
import {
  captureRpcSourceScopeMatcher,
  type SessionRuntimeScope,
} from "../session-runtime-scope.js";

const PENDING_INPUT_DISPLAY_MAX_BYTES = 128 * 1024;
// Correlation is useful for browser UUIDs, but arbitrary external run IDs must
// not turn a bounded display page into an unbounded payload. Never truncate IDs.
const PENDING_INPUT_CORRELATION_MAX_CHARS = 256;

/** Capture follow-up queue correlation within the selected Gateway and physical session. */
export function captureQueuedChatInputRunIds(
  scope: SessionRuntimeScope & { sessionKey: string; sessionId: string; agentId?: string },
): ReadonlySet<string> {
  const matchesScope = captureRpcSourceScopeMatcher(scope);
  return new Set(
    listRpcSourceEntries().flatMap(([runId, source]) => {
      if (
        runId.length > PENDING_INPUT_CORRELATION_MAX_CHARS ||
        !matchesScope(source) ||
        !isRpcSourceQueued(source) ||
        source.input.custody.enqueued !== true ||
        source.input.injection !== undefined
      ) {
        return [];
      }
      const identity = getRpcSourceIdentity(source);
      return identity.sessionKey === scope.sessionKey &&
        identity.sessionId === scope.sessionId &&
        identity.agentId === scope.agentId
        ? [runId]
        : [];
    }),
  );
}

export function projectPendingInputMessage(
  input: SessionPendingInput,
  maxChars: number,
  projectProfile = createCurrentUserProfileMessageProjector(resolveCurrentUserProfileDisplay),
  resolveCronJobName?: (jobId: string) => string | undefined,
) {
  if (input.state === "cancelled" && input.message.display === false) {
    // Retire retained client copies without returning a withdrawn prompt's content.
    return {
      role: "user",
      content: [],
      display: false,
      timestamp: input.acceptedAt,
      __openclaw: { id: `${CHAT_PENDING_INPUT_MESSAGE_PREFIX}${input.id}` },
    };
  }
  const projected = projectChatDisplayMessage(input.message, { maxChars, resolveCronJobName });
  const message = projected ? projectProfile(projected) : undefined;
  if (!message) {
    return undefined;
  }
  const metadata = { ...asOptionalRecord(message["__openclaw"]) };
  delete metadata.idempotencyKey;
  delete metadata.runId;
  return {
    ...message,
    timestamp: input.acceptedAt,
    idempotencyKey: undefined,
    __openclaw: { ...metadata, id: `${CHAT_PENDING_INPUT_MESSAGE_PREFIX}${input.id}` },
  };
}

export async function readChatPendingInputs(
  scope: Parameters<typeof listSessionPendingInputs>[0],
  options: {
    before?: number;
    limit: number;
    maxChars: number;
    queuedRunIds?: ReadonlySet<string>;
    cronStorePath?: string;
  },
): Promise<ChatPendingInputsPage> {
  const page = await listSessionPendingInputs(scope, {
    before: options.before,
    limit: Math.min(options.limit, 20),
  });
  const resolveCronJobName = await prepareForwardedMessageCronJobNameResolver(
    page.items.map((input) => input.message),
    options.cronStorePath,
  );
  const projectProfile = createCurrentUserProfileMessageProjector(resolveCurrentUserProfileDisplay);
  const visible = page.items.flatMap((input) => {
    const message = projectPendingInputMessage(
      input,
      options.maxChars,
      projectProfile,
      resolveCronJobName,
    );
    return message ? [{ input, message }] : [];
  });
  const messages = replaceOversizedChatHistoryMessages({
    messages: visible.map(({ message }) => message),
    maxSingleMessageBytes: Math.floor(
      PENDING_INPUT_DISPLAY_MAX_BYTES / Math.max(page.items.length, 1),
    ),
  }).messages;
  return {
    ...page,
    ...(options.queuedRunIds ? { queuedCount: options.queuedRunIds.size } : {}),
    items: visible.map(({ input: item }, index) => {
      const display: ChatPendingInputsPage["items"][number] = {
        id: item.id,
        acceptedAt: item.acceptedAt,
        state: item.state,
        message: messages[index],
      };
      if (item.runId.length <= PENDING_INPUT_CORRELATION_MAX_CHARS) {
        display.runId = item.runId;
        if (item.state === "queued" && options.queuedRunIds?.has(item.runId)) {
          display.queued = true;
        }
      }
      return display;
    }),
  };
}
