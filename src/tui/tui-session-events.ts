import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  readSessionMessageIdentity,
  readSessionMessageSequence,
} from "../../packages/gateway-client/src/session-projection.js";
import { parseAgentSessionKey, toAgentStoreSessionKey } from "../routing/session-key.js";
import { extractTextFromMessage } from "./tui-formatters.js";
import { extractTuiImageSources, type TuiImageSource } from "./tui-images.js";
import type { SessionMessageEvent, TuiStateAccess } from "./tui-types.js";

type OwnedTuiEvent = { sessionKey?: string | null; agentId?: string | null };

/** Reads the durable user identity without mistaking another run's prompt for this one. */
export function readTuiSessionUserMessage(event: SessionMessageEvent): {
  text: string;
  messageId: string;
  runId?: string;
  sendId?: string;
  images?: readonly TuiImageSource[];
} | null {
  const message = event.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }
  const record = message as Record<string, unknown>;
  const identity = readSessionMessageIdentity(message, event);
  if (identity?.role !== "user") {
    return null;
  }
  const persistedSequence = readSessionMessageSequence(message);
  // Imported IDs are provider-local. Namespace their complete source tuple or
  // persisted transcript position so incomplete imports cannot collide with native rows.
  const messageId = identity.isImported
    ? identity.externalSource
      ? `external:${identity.externalSource}`
      : persistedSequence !== null
        ? `imported-seq:${persistedSequence}`
        : null
    : (identity.id ?? (identity.sequence !== null ? `seq:${identity.sequence}` : null));
  const text = extractTextFromMessage(record);
  if (!messageId || !text) {
    return null;
  }
  const images = extractTuiImageSources(message);
  return {
    messageId,
    text,
    ...(identity.runId ? { runId: identity.runId } : {}),
    ...(identity.sendId ? { sendId: identity.sendId } : {}),
    ...(images.length > 0 ? { images } : {}),
  };
}

/** Preserves opaque peer IDs while guarding canonical, global, and alias ownership. */
export function matchesSelectedTuiSession(
  state: TuiStateAccess,
  event: OwnedTuiEvent,
  options?: { requireAliasOwnership?: boolean },
): boolean {
  const legacyOwner =
    normalizeLowercaseStringOrEmpty(event.sessionKey) === "global" || options?.requireAliasOwnership
      ? state.agentDefaultId
      : state.currentAgentId;
  return matchesOwnedTuiSession(state.currentSessionKey, state.currentAgentId, event, legacyOwner);
}

/** Compare qualified identities without accepting contradictory owner claims. */
export function matchesOwnedTuiSession(
  session: string,
  agentId: string,
  event: OwnedTuiEvent,
  legacyOwnerAgentId?: string,
) {
  const owner = normalizeLowercaseStringOrEmpty(event.agentId);
  const selected = normalizeLowercaseStringOrEmpty(agentId);
  const eventOwner =
    parseAgentSessionKey(event.sessionKey)?.agentId ||
    owner ||
    normalizeLowercaseStringOrEmpty(legacyOwnerAgentId);
  return (
    eventOwner === selected &&
    (!owner || owner === selected) &&
    Boolean(event.sessionKey?.trim() && session.trim()) &&
    toAgentStoreSessionKey({ requestKey: event.sessionKey, agentId: selected }) ===
      toAgentStoreSessionKey({ requestKey: session, agentId: selected })
  );
}
