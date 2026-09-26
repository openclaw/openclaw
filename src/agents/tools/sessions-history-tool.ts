/**
 * sessions_history built-in tool.
 *
 * Reads bounded, redacted session transcript history after session visibility filtering.
 */
import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import {
  ChatHistoryParamsSchema,
  ChatPendingInputsPageSchema,
  type ChatHistoryDeltaResult,
  type ChatPendingInputsPage,
} from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { capArrayByJsonBytes } from "../../gateway/session-transcript-readers.js";
import { jsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import { redactToolPayloadText } from "../../logging/redact.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { truncateUtf16Safe } from "../../utils.js";
import { resolveSessionAgentId, resolveSessionAgentIds } from "../agent-scope.js";
import {
  describeSessionLinkRule,
  describeSessionsHistoryTool,
  SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import { stripToolMessages } from "./chat-history-text.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
  readToolStringParam,
  ToolInputError,
} from "./common.js";
import {
  callAgentToolGatewayRequest,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";
import {
  resolveSessionToolTargetAgentId,
  runWithScopedSessionAccess,
} from "./scoped-session-access.js";
import {
  createSessionVisibilityRowChecker,
  formatSessionToolAccessDenial,
  resolveSessionReference,
  resolveSessionToolAccess,
  resolveSessionToolContext,
  resolveVisibleSessionReference,
  shouldResolveSessionIdInput,
} from "./sessions-helpers.js";

const SessionsHistoryToolSchema = Type.Object({
  sessionKey: ChatHistoryParamsSchema.properties.sessionKey,
  limit: ChatHistoryParamsSchema.properties.limit,
  offset: Type.With(ChatHistoryParamsSchema.properties.offset, {
    description:
      "Plain-pagination offset. Ignored when messageId is set; limit still bounds anchored history.",
  }),
  pendingBefore: ChatHistoryParamsSchema.properties.pendingBefore,
  messageId: Type.With(ChatHistoryParamsSchema.properties.messageId, {
    description: "Return history around this message id. Ignores offset; limit bounds the window.",
  }),
  sessionId: Type.With(ChatHistoryParamsSchema.properties.sessionId, {
    description:
      "Transcript session id that owns messageId. Requires messageId; omit for the latest tail.",
  }),
  includeTools: Type.Optional(Type.Boolean()),
});

const SessionsHistoryOutputSchema = Type.Union([
  Type.Object(
    {
      sessionKey: Type.String(),
      messages: Type.Array(Type.Unknown()),
      truncated: Type.Boolean(),
      droppedMessages: Type.Boolean(),
      contentTruncated: Type.Boolean(),
      contentRedacted: Type.Boolean(),
      bytes: Type.Number(),
      sessionLinkRule: Type.Optional(
        Type.String({
          description: "How to build Control UI URLs for sessionKey values in this result.",
        }),
      ),
      offset: Type.Optional(Type.Number()),
      nextOffset: Type.Optional(Type.Number()),
      hasMore: Type.Optional(Type.Boolean()),
      totalMessages: Type.Optional(Type.Number()),
      pendingInputs: Type.Optional(ChatPendingInputsPageSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      status: Type.Union([Type.Literal("error"), Type.Literal("forbidden")]),
      error: Type.String(),
    },
    { additionalProperties: false },
  ),
]);

const SESSIONS_HISTORY_MAX_BYTES = 80 * 1024;
const SESSIONS_HISTORY_TEXT_MAX_CHARS = 4000;
const SESSIONS_HISTORY_PENDING_MAX_BYTES = 4096;
type ChatHistoryPaginationMetadata = Partial<
  Record<"offset" | "nextOffset" | "totalMessages", number> & { hasMore: boolean }
>;

function truncateHistoryText(
  text: string,
  maxChars = SESSIONS_HISTORY_TEXT_MAX_CHARS,
): {
  text: string;
  truncated: boolean;
  redacted: boolean;
} {
  // sessions_history is a tool surface, not a log sink. Keep it redacted even
  // when operators disable general-purpose log redaction.
  const sanitized = redactToolPayloadText(text);
  const redacted = sanitized !== text;
  if (sanitized.length <= maxChars) {
    return { text: sanitized, truncated: false, redacted };
  }
  const cut = truncateUtf16Safe(sanitized, maxChars);
  return { text: `${cut}\n…(truncated)…`, truncated: true, redacted };
}

function sanitizeHistoryContentBlock(
  block: unknown,
  maxChars: number,
): {
  block: unknown;
  truncated: boolean;
  redacted: boolean;
} {
  if (!block || typeof block !== "object") {
    return { block, truncated: false, redacted: false };
  }
  const entry = { ...(block as Record<string, unknown>) };
  let truncated = false;
  let redacted = false;
  const fields =
    entry.type === "thinking" ? ["text", "thinking", "partialJson"] : ["text", "partialJson"];
  for (const field of fields) {
    const value = entry[field];
    if (typeof value === "string") {
      const res = truncateHistoryText(value, maxChars);
      entry[field] = res.text;
      truncated ||= res.truncated;
      redacted ||= res.redacted;
    }
  }
  return { block: entry, truncated, redacted };
}

function sanitizeHistoryMessage(
  message: unknown,
  maxChars = SESSIONS_HISTORY_TEXT_MAX_CHARS,
): {
  message: unknown;
  truncated: boolean;
  redacted: boolean;
} {
  if (!message || typeof message !== "object") {
    return { message, truncated: false, redacted: false };
  }
  const entry = { ...(message as Record<string, unknown>) };
  let truncated = false;
  let redacted = false;
  // Tool result details often contain very large nested payloads.
  for (const field of ["details", "usage", "cost"]) {
    if (field in entry) {
      delete entry[field];
      truncated = true;
    }
  }

  if (typeof entry.content === "string") {
    const res = truncateHistoryText(entry.content, maxChars);
    entry.content = res.text;
    truncated ||= res.truncated;
    redacted ||= res.redacted;
  } else if (Array.isArray(entry.content)) {
    const updated = entry.content.map((block) => sanitizeHistoryContentBlock(block, maxChars));
    entry.content = updated.map((item) => item.block);
    truncated ||= updated.some((item) => item.truncated);
    redacted ||= updated.some((item) => item.redacted);
  }
  if (typeof entry.text === "string") {
    const res = truncateHistoryText(entry.text, maxChars);
    entry.text = res.text;
    truncated ||= res.truncated;
    redacted ||= res.redacted;
  }
  return { message: entry, truncated, redacted };
}

function boundPendingInputs(page: ChatPendingInputsPage) {
  // Pending input is context for an intentional next action, never executable
  // history. Keep the whole page addressable while sharing one hard byte cap.
  const metadata = page.items.map(({ id, state, acceptedAt }) => ({ id, state, acceptedAt }));
  const messageBudget = Math.floor(
    (SESSIONS_HISTORY_PENDING_MAX_BYTES -
      jsonUtf8Bytes({ ...page, items: metadata }) -
      page.items.length * 12) /
      Math.max(page.items.length, 1),
  );
  let truncated = false;
  let redacted = false;
  const items = page.items.map((item, index) => {
    const result = sanitizeHistoryMessage(item.message, Math.max(1, Math.floor(messageBudget / 8)));
    redacted ||= result.redacted;
    const record = asOptionalRecord(result.message);
    const media = asOptionalRecord(record?.["__openclaw"])?.media;
    const message = { role: "user", content: record?.content, ...(media ? { media } : {}) };
    const oversized = jsonUtf8Bytes(message) > messageBudget;
    truncated ||= result.truncated || oversized;
    return {
      ...metadata[index],
      message: oversized ? { role: "user", content: "[Input omitted; request limit: 1]" } : message,
    };
  });
  const pendingInputs = {
    items,
    total: page.total,
    ...(page.nextBefore !== undefined ? { nextBefore: page.nextBefore } : {}),
  };
  return { pendingInputs, bytes: jsonUtf8Bytes(pendingInputs), truncated, redacted };
}

function enforceSessionsHistoryHardCap(params: {
  items: unknown[];
  bytes: number;
  maxBytes: number;
}): { items: unknown[]; bytes: number; hardCapped: boolean } {
  if (params.bytes <= params.maxBytes) {
    return { items: params.items, bytes: params.bytes, hardCapped: false };
  }

  const last = params.items.at(-1);
  const lastOnly = last ? [last] : [];
  const lastBytes = jsonUtf8Bytes(lastOnly);
  if (lastBytes <= params.maxBytes) {
    return { items: lastOnly, bytes: lastBytes, hardCapped: true };
  }

  const placeholder = [buildSessionsHistoryOmittedPlaceholder(last)];
  return { items: placeholder, bytes: jsonUtf8Bytes(placeholder), hardCapped: true };
}

function readHistoryMessageSeq(message: unknown): number | undefined {
  const meta = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]);
  return asPositiveSafeInteger(meta?.seq);
}

function readHistoryMessageId(message: unknown): string | undefined {
  const meta = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]);
  const id = meta?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function capSessionsHistoryAroundMessage(
  items: unknown[],
  messageId: string,
  maxBytes: number,
): { items: unknown[]; bytes: number } {
  const anchorIndex = items.findIndex((item) => readHistoryMessageId(item) === messageId);
  if (anchorIndex === -1) {
    return capArrayByJsonBytes(items, maxBytes);
  }

  let start = anchorIndex;
  let end = anchorIndex + 1;
  let bytes = jsonUtf8Bytes([items[anchorIndex]]);
  let canGrowOlder = start > 0;
  let canGrowNewer = end < items.length;
  while (canGrowOlder || canGrowNewer) {
    if (canGrowOlder) {
      // Singleton arrays preserve JSON's array-element encoding; replacing one
      // bracket with a comma gives the exact growth of this nonempty window.
      const candidateBytes = bytes + jsonUtf8Bytes([items[start - 1]]) - 1;
      if (candidateBytes <= maxBytes) {
        start -= 1;
        bytes = candidateBytes;
      } else {
        canGrowOlder = false;
      }
    }
    canGrowOlder &&= start > 0;

    if (canGrowNewer) {
      const candidateBytes = bytes + jsonUtf8Bytes([items[end]]) - 1;
      if (candidateBytes <= maxBytes) {
        end += 1;
        bytes = candidateBytes;
      } else {
        canGrowNewer = false;
      }
    }
    canGrowNewer &&= end < items.length;
  }
  return { items: items.slice(start, end), bytes };
}

function buildSessionsHistoryOmittedPlaceholder(source: unknown): Record<string, unknown> {
  const seq = readHistoryMessageSeq(source);
  const id = readHistoryMessageId(source);
  return {
    role: "assistant",
    content: "[sessions_history omitted: message too large]",
    ...(seq !== undefined || id !== undefined
      ? {
          __openclaw: {
            ...(seq !== undefined ? { seq } : {}),
            ...(id !== undefined ? { id } : {}),
          },
        }
      : {}),
  };
}

function resolveSessionsHistoryPaginationMetadata(params: {
  messages: unknown[];
  result: ChatHistoryPaginationMetadata | undefined;
  requestedOffset: number | undefined;
  requestedMessageId: string | undefined;
}): ChatHistoryPaginationMetadata {
  const result = params.result;
  if (params.requestedMessageId) {
    return typeof result?.totalMessages === "number" ? { totalMessages: result.totalMessages } : {};
  }
  const offset =
    typeof result?.offset === "number"
      ? result.offset
      : params.requestedOffset !== undefined
        ? params.requestedOffset
        : undefined;
  if (offset === undefined) {
    return {};
  }

  const totalMessages =
    typeof result?.totalMessages === "number" ? result.totalMessages : undefined;
  if (totalMessages === undefined) {
    return {
      offset,
      ...(typeof result?.nextOffset === "number" ? { nextOffset: result.nextOffset } : {}),
      ...(typeof result?.hasMore === "boolean" ? { hasMore: result.hasMore } : {}),
    };
  }

  // Respect Gateway replay cursors and this tool's own byte cap while always advancing.
  const seq = params.messages
    .map((message) => readHistoryMessageSeq(message))
    .find((value): value is number => typeof value === "number");
  const gatewayOffset = result?.nextOffset;
  const nextOffset =
    seq === undefined
      ? gatewayOffset
      : Math.max(offset + 1, Math.min(gatewayOffset ?? totalMessages, totalMessages - seq + 1));
  const hasMore =
    nextOffset !== undefined
      ? nextOffset < totalMessages
      : typeof result?.hasMore === "boolean"
        ? result.hasMore
        : undefined;
  return {
    offset,
    ...(hasMore === true && nextOffset !== undefined ? { nextOffset } : {}),
    ...(hasMore !== undefined ? { hasMore } : {}),
    totalMessages,
  };
}

export function createSessionsHistoryTool(opts?: {
  agentSessionKey?: string;
  sessionReadScopeKey?: string;
  requesterAgentIdOverride?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: AgentToolGatewayRequestCaller;
  sessionLinkBase?: string;
}): AnyAgentTool {
  return {
    label: "Session History",
    name: "sessions_history",
    displaySummary: SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsHistoryTool({ sessionLinkBase: opts?.sessionLinkBase }),
    parameters: SessionsHistoryToolSchema,
    outputSchema: SessionsHistoryOutputSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const gatewayCall = opts?.callGateway ?? callAgentToolGatewayRequest;
      const sessionKeyParam = readToolStringParam(params, "sessionKey", {
        required: true,
      });
      const limit = readPositiveIntegerParam(params, "limit");
      const offset = readNonNegativeIntegerParam(params, "offset");
      const pendingBefore = readPositiveIntegerParam(params, "pendingBefore");
      const messageId = readToolStringParam(params, "messageId");
      const sessionId = readToolStringParam(params, "sessionId");
      if (sessionId && !messageId) {
        throw new ToolInputError("sessionId requires messageId");
      }
      // Keep redundant model arguments out of the strict Gateway pagination contract.
      const paginationOffset = messageId ? undefined : offset;
      const includeTools = Boolean(params.includeTools);
      const {
        cfg,
        mainKey,
        alias,
        effectiveRequesterKey,
        mainSessionKey,
        restrictToSpawned,
        sessionVisibility: visibility,
        a2aPolicy,
      } = resolveSessionToolContext(opts);
      const requesterAgentId = resolveSessionAgentIds({
        config: cfg,
        sessionKey: effectiveRequesterKey,
        agentId: opts?.requesterAgentIdOverride,
      }).sessionAgentId;
      const normalizedInputKey = sessionKeyParam.trim();
      const isCurrentSession = normalizedInputKey === "current";
      const isConfiguredMainAlias =
        normalizedInputKey === "main" ||
        normalizedInputKey === "global" ||
        normalizedInputKey === mainKey ||
        normalizedInputKey === alias;
      const inputStoreOwner =
        shouldResolveSessionIdInput(sessionKeyParam) && !isConfiguredMainAlias
          ? { kind: "none" as const }
          : resolvePersistedSessionStoreOwnerForKey(cfg, sessionKeyParam);
      const resolvedSession = await resolveSessionReference({
        action: "history",
        sessionKey: sessionKeyParam,
        ...(isCurrentSession
          ? { agentId: requesterAgentId }
          : inputStoreOwner.kind === "configured"
            ? { agentId: inputStoreOwner.agentId }
            : {}),
        keyAgentId: requesterAgentId,
        alias,
        mainKey,
        requesterInternalKey: effectiveRequesterKey,
        restrictToSpawned,
        callGateway: gatewayCall,
      });
      if (!resolvedSession.ok) {
        return jsonResult({ status: resolvedSession.status, error: resolvedSession.error });
      }
      const resolutionAccess = createSessionVisibilityRowChecker({
        action: "history",
        defaultAgentId:
          resolvedSession.agentId ??
          resolveSessionAgentId({ config: cfg, sessionKey: resolvedSession.key }),
        requesterAgentId,
        requesterSessionKey: effectiveRequesterKey,
        mainSessionKey,
        visibility,
        a2aPolicy,
      }).check({ key: resolvedSession.key });
      const visibleSession = await resolveVisibleSessionReference({
        action: "history",
        resolvedSession,
        requesterSessionKey: effectiveRequesterKey,
        requesterAgentId,
        restrictToSpawned,
        visibilitySessionKey: sessionKeyParam,
        concealResolutionError: resolutionAccess.allowed ? undefined : resolutionAccess.error,
        callGateway: gatewayCall,
      });
      if (!visibleSession.ok) {
        return jsonResult({
          status: visibleSession.status,
          error: visibleSession.error,
        });
      }
      // From here on, use the canonical key (sessionId inputs already resolved).
      const resolvedKey = visibleSession.key;
      const displayKey = visibleSession.displayKey;
      const targetAgentId = resolveSessionToolTargetAgentId({
        cfg,
        targetSessionKey: resolvedKey,
        resolvedAgentId: visibleSession.agentId,
        requesterAgentId,
      });

      const authorizationKey =
        targetAgentId !== requesterAgentId && !parseAgentSessionKey(resolvedKey)
          ? `agent:${targetAgentId}:${resolvedKey}`
          : resolvedKey;
      const access = await resolveSessionToolAccess({
        action: "history",
        requesterAgentId,
        requesterSessionKey: effectiveRequesterKey,
        sessionReadScopeKey: opts?.sessionReadScopeKey ? effectiveRequesterKey : undefined,
        mainSessionKey,
        authorizationTargetSessionKey: authorizationKey,
        targetAgentId,
        targetSessionKey: resolvedKey,
        requesterOwned: visibleSession.requesterOwned,
        visibility,
        a2aPolicy,
        callGateway: gatewayCall,
      });
      if (!access.allowed) {
        return jsonResult({
          status: access.status,
          error: formatSessionToolAccessDenial(access, {
            action: "history",
            targetSessionKey: displayKey,
          }),
        });
      }

      const result = await runWithScopedSessionAccess({
        cfg,
        agentId: targetAgentId,
        expectedSessionId: access.expectedSessionId,
        targetSessionKey: resolvedKey,
        run: async () =>
          await gatewayCall<
            Pick<ChatHistoryDeltaResult, "messages" | "pendingInputs"> &
              ChatHistoryPaginationMetadata
          >({
            method: "chat.history",
            params: {
              sessionKey: resolvedKey,
              agentId: targetAgentId,
              limit,
              ...(paginationOffset !== undefined ? { offset: paginationOffset } : {}),
              ...(pendingBefore !== undefined ? { pendingBefore } : {}),
              ...(messageId ? { messageId } : {}),
              ...(sessionId ? { sessionId } : {}),
            },
          }),
      });
      const rawMessages = Array.isArray(result?.messages) ? result.messages : [];
      const pending = result?.pendingInputs ? boundPendingInputs(result.pendingInputs) : undefined;
      const transcriptBudget = SESSIONS_HISTORY_MAX_BYTES - (pending?.bytes ?? 0);
      const selectedMessages = includeTools ? rawMessages : stripToolMessages(rawMessages);
      const sanitizedMessages = selectedMessages.map((message) => sanitizeHistoryMessage(message));
      const contentTruncated =
        sanitizedMessages.some((entry) => entry.truncated) || pending?.truncated === true;
      const contentRedacted =
        sanitizedMessages.some((entry) => entry.redacted) || pending?.redacted === true;
      const sanitizedItems = sanitizedMessages.map((entry) => entry.message);
      const cappedMessages = messageId
        ? capSessionsHistoryAroundMessage(sanitizedItems, messageId, transcriptBudget)
        : capArrayByJsonBytes(sanitizedItems, transcriptBudget);
      const droppedMessages = cappedMessages.items.length < selectedMessages.length;
      const hardened = enforceSessionsHistoryHardCap({
        items: cappedMessages.items,
        bytes: cappedMessages.bytes,
        maxBytes: transcriptBudget,
      });
      const pagination = resolveSessionsHistoryPaginationMetadata({
        messages: hardened.items,
        result,
        requestedOffset: offset,
        requestedMessageId: messageId,
      });
      return jsonResult({
        sessionKey: displayKey,
        messages: hardened.items,
        truncated: droppedMessages || contentTruncated || hardened.hardCapped,
        droppedMessages: droppedMessages || hardened.hardCapped,
        contentTruncated,
        contentRedacted,
        bytes: hardened.bytes + (pending?.bytes ?? 0),
        ...(pending ? { pendingInputs: pending.pendingInputs } : {}),
        ...(opts?.sessionLinkBase
          ? { sessionLinkRule: describeSessionLinkRule(opts.sessionLinkBase) }
          : {}),
        ...pagination,
      });
    },
  };
}
