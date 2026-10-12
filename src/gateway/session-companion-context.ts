import { resolveNonNegativeIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { collectTextContentBlocks } from "../agents/content-blocks.js";
import { extractStoredAssistantText } from "../agents/tools/chat-history-text.js";
import { getRuntimeConfig } from "../config/io.js";
import { withSessionActorStorage } from "../config/sessions/session-actor-storage-binding.js";
import { captureSessionEntryMetadataRead } from "../config/sessions/session-entry-source-authority.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import {
  selectSessionCompanionReferenceItems,
  type SessionCompanionContextMessage,
  type SessionCompanionPreparedContext,
} from "./session-companion-state.js";
import { readSessionTranscriptBoundedMessageTailPageAsync } from "./session-transcript-readers.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";

const CONTEXT_MAX_MESSAGES = 40;
const CONTEXT_MAX_BYTES = 24 * 1024;
const CONTEXT_MESSAGE_MAX_CHARS = 4000;
const CONTEXT_READ_MAX_SCANNED_MESSAGES = 4096;
const CONTEXT_READ_MAX_BYTES = 1024 * 1024;
const CONTEXT_READ_PAGE_MESSAGES = 128;

type SessionCompanionContextReadResult =
  | { kind: "ready"; context: SessionCompanionPreparedContext }
  | { kind: "missing" }
  | { kind: "unavailable" };

export type SessionCompanionContextReader = {
  currentSessionId: (params: {
    agentId: string;
    sessionKey: string;
  }) => Promise<string | undefined>;
  read: typeof readSessionCompanionContext;
};

function normalizeContextText(value: string): string {
  return truncateUtf16Safe(
    redactToolPayloadText(value).replace(/\s+/gu, " ").trim(),
    CONTEXT_MESSAGE_MAX_CHARS,
  );
}

function extractUserText(message: unknown): string | undefined {
  const content = asOptionalObjectRecord(message)?.content;
  const text = typeof content === "string" ? content : collectTextContentBlocks(content).join("\n");
  return normalizeContextText(text) || undefined;
}

function appendContextMessages(
  events: Array<{ event: unknown }>,
  messages: SessionCompanionContextMessage[],
): void {
  // Keep newest-first context across pages; older discarded rows need no text work.
  for (
    let index = events.length - 1;
    index >= 0 && messages.length < CONTEXT_MAX_MESSAGES;
    index--
  ) {
    const message = asOptionalObjectRecord(asOptionalObjectRecord(events[index]?.event)?.message);
    const role = message?.role;
    const text =
      role === "assistant"
        ? normalizeContextText(extractStoredAssistantText(message) ?? "")
        : role === "user"
          ? extractUserText(message)
          : undefined;
    if (text && (role === "assistant" || role === "user")) {
      messages.push({ role, text, ts: resolveNonNegativeIntegerOption(message?.timestamp, 0) });
    }
  }
}

async function readSessionCompanionContext(params: {
  agentId: string;
  sessionKey: string;
  signal?: AbortSignal;
}): Promise<SessionCompanionContextReadResult> {
  if (isIncognitoSessionKey(params.sessionKey)) {
    const assertCurrent = () => params.signal?.throwIfAborted();
    return (
      (await withSessionActorStorage(
        params,
        {
          lifetime: { assertCurrent, assertReadable: assertCurrent },
          authority: { assertCurrent, authorize: assertCurrent },
        },
        ({ actor, authority, path }) =>
          readSessionCompanionContextFromEntry(
            params,
            { entry: actor.snapshot(authority)?.entry, storePath: path },
            () => {
              assertCurrent();
              actor.assertReadable();
            },
          ),
      )) ?? { kind: "missing" }
    );
  }
  return readSessionCompanionContextFromEntry(
    params,
    await loadGatewaySessionEntryReadOnlyInWorker({
      cfg: getRuntimeConfig(),
      key: params.sessionKey,
      agentId: params.agentId,
    }),
  );
}

async function readSessionCompanionContextFromEntry(
  params: { agentId: string; sessionKey: string; signal?: AbortSignal },
  loaded: { entry?: { sessionId: string }; storePath: string },
  assertCurrent?: () => void,
): Promise<SessionCompanionContextReadResult> {
  const sessionId = loaded.entry?.sessionId?.trim();
  if (!sessionId) {
    return { kind: "missing" };
  }
  try {
    const scope = {
      agentId: params.agentId,
      sessionId,
      sessionKey: params.sessionKey,
      storePath: loaded.storePath,
    };
    if (params.signal?.aborted) {
      return { kind: "unavailable" };
    }
    let offset = 0;
    let rawBytes = 0;
    let scannedMessages = 0;
    let totalMessages = 0;
    let stoppedAtOlderByteBoundary = false;
    const contextMessages: SessionCompanionContextMessage[] = [];
    while (
      contextMessages.length < CONTEXT_MAX_MESSAGES &&
      scannedMessages < CONTEXT_READ_MAX_SCANNED_MESSAGES
    ) {
      const page = await readSessionTranscriptBoundedMessageTailPageAsync(scope, {
        maxBytes: CONTEXT_READ_MAX_BYTES - rawBytes,
        maxMessages: Math.min(
          CONTEXT_READ_PAGE_MESSAGES,
          CONTEXT_READ_MAX_SCANNED_MESSAGES - scannedMessages,
        ),
        offset,
      });
      assertCurrent?.();
      if (params.signal?.aborted) {
        return { kind: "unavailable" };
      }
      totalMessages = page.totalMessages;
      const pageIsPartial = page.newestContiguousEventCount !== page.scannedMessages;
      // Sparse bounded pages may include older rows beyond an oversized gap.
      // Only the contiguous newest suffix is authoritative companion context.
      const pageEvents =
        page.newestContiguousEventCount === page.events.length
          ? page.events
          : page.events.slice(page.events.length - page.newestContiguousEventCount);
      rawBytes += page.serializedBytes;
      scannedMessages += page.scannedMessages;
      offset += page.scannedMessages;
      appendContextMessages(pageEvents, contextMessages);
      if (pageIsPartial) {
        if (contextMessages.length === 0) {
          return { kind: "unavailable" };
        }
        stoppedAtOlderByteBoundary = true;
        break;
      }
      if (page.scannedMessages === 0 || offset >= totalMessages) {
        break;
      }
    }
    if (
      contextMessages.length < CONTEXT_MAX_MESSAGES &&
      offset < totalMessages &&
      !stoppedAtOlderByteBoundary
    ) {
      return { kind: "unavailable" };
    }
    assertCurrent?.();
    return {
      kind: "ready",
      context: {
        empty: totalMessages === 0,
        messages: selectSessionCompanionReferenceItems(contextMessages, CONTEXT_MAX_BYTES),
        sessionId,
      },
    };
  } catch {
    return { kind: "unavailable" };
  }
}

export const defaultSessionCompanionContextReader: SessionCompanionContextReader = {
  currentSessionId: async ({ agentId, sessionKey }) => {
    const memory = captureSessionEntryMetadataRead({ agentId, sessionKey }, () => {});
    if (memory) {
      return memory.readCurrent()?.sessionId?.trim();
    }
    const loaded = await loadGatewaySessionEntryReadOnlyInWorker({
      cfg: getRuntimeConfig(),
      key: sessionKey,
      agentId,
    });
    return loaded.entry?.sessionId?.trim() || undefined;
  },
  read: readSessionCompanionContext,
};
