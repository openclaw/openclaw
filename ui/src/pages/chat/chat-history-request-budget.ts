// Adaptive request envelopes belong to on-demand packet reads. Eager residency
// must not import this owner and pull packet-only work into the boot closure.
import {
  reduceSessionProjection,
  type SessionProjectionState,
} from "@openclaw/gateway-client/browser";
import { nativeHistoryMessageSourceIdentity } from "../../lib/chat/history-message-identity.ts";
import { resolveUiSelectedSessionAgentId } from "../../lib/sessions/session-key.ts";
import {
  CHAT_RESIDENT_ENTRY_TARGET,
  CHAT_RESIDENT_WEIGHT_TARGET,
  messageWeight,
  sourceGroups,
} from "./chat-history-cost.ts";
import {
  CHAT_HISTORY_REQUEST_LIMIT,
  CHAT_HISTORY_REQUEST_MAX_BYTES,
  type ChatHistoryRequestBudget,
} from "./chat-history-request-params.ts";
import {
  CHAT_PROJECTION_SCOPE_KEYS,
  readChatSessionProjectionScope,
} from "./chat-projection-scope.ts";
import { type getChatSessionProjection, readChatSessionProjection } from "./history-merge.ts";

/** Estimate only the next wire read; exact admission still owns every exception. */
function prepareChatHistoryRequestBudget(
  projection: SessionProjectionState,
  messages: readonly unknown[],
  requiredSources: ReadonlySet<string>,
  pinnedRunId?: string | null,
): ChatHistoryRequestBudget | undefined {
  const pins = reduceSessionProjection(projection, {
    type: "residencyChanged",
    messages: [],
    pinnedRunIds: pinnedRunId ? [pinnedRunId] : [],
  }).messages;
  const mandatory = new Set(requiredSources);
  for (const message of pins) {
    const source = nativeHistoryMessageSourceIdentity(message);
    if (source) {
      mandatory.add(source);
    }
  }
  const groups = sourceGroups(messages);
  if ([...requiredSources].some((source) => !groups.has(source))) {
    return undefined;
  }
  let count = 0;
  let weight = 1;
  const reserved = new Map<unknown, number>();
  const reserve = (values: readonly unknown[]) => {
    const occurrences = new Map<unknown, number>();
    for (const message of values) {
      const occurrence = (occurrences.get(message) ?? 0) + 1;
      occurrences.set(message, occurrence);
      if (occurrence > (reserved.get(message) ?? 0)) {
        count++;
        weight += messageWeight(message);
        reserved.set(message, occurrence);
      }
    }
  };
  const required = (message: unknown) =>
    mandatory.has(nativeHistoryMessageSourceIdentity(message) ?? "");
  // Count complete source fragments and repeated occurrences, then union pins
  // and the newest local reply without lending their atomicity exceptions.
  reserve(messages.filter(required));
  reserve(projection.messages.filter(required));
  reserve(pins);
  const local = projection.entries.findLast((entry) => entry.localOutput);
  if (local) {
    reserve([local.message]);
  }
  const limit = CHAT_RESIDENT_ENTRY_TARGET - count;
  // UTF-8 wire bytes consume at least as much as the JSON code-unit estimate.
  const maxBytes = CHAT_RESIDENT_WEIGHT_TARGET - weight;
  return limit > CHAT_HISTORY_REQUEST_LIMIT && maxBytes > CHAT_HISTORY_REQUEST_MAX_BYTES
    ? { limit, maxBytes }
    : undefined;
}

/** Tentative capacity reads never initialize or publish a projection. */
export function readChatHistoryRequestBudget(
  owner: Parameters<typeof getChatSessionProjection>[0],
  prepared: { messages: readonly unknown[]; requiredSources: ReadonlySet<string>; fits?: boolean },
) {
  const projection = readChatSessionProjection(owner);
  // Pending-input hydration binds the selected agent even when the wire request omits it.
  // Capacity must compare that same identity without initializing unknown custody.
  const scope = readChatSessionProjectionScope(owner, {
    agentId: resolveUiSelectedSessionAgentId(owner),
  });
  return prepared.fits !== false &&
    projection &&
    CHAT_PROJECTION_SCOPE_KEYS.every((key) => projection.scope[key] === scope[key])
    ? prepareChatHistoryRequestBudget(
        projection,
        prepared.messages,
        prepared.requiredSources,
        owner.lastLocalTerminalReconcile?.runId,
      )
    : undefined;
}
