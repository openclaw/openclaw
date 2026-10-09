import {
  readAssistantStreamSegmentIdentity,
  readSessionMessageIdentity,
} from "@openclaw/gateway-client/browser";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import {
  userTurnRunId,
  type ChatProjection,
  type TurnInsertionBounds,
} from "./chat-thread-items.ts";
import { chatItemStartsUserTurn, isInterSessionMessage } from "./chat-turn-boundary.ts";
import { persistedSteerTargetRunId } from "./stream-causal-boundary.ts";
import { readLiveTerminalRunId } from "./terminal-message-identity.ts";
import { buildToolStreamIdentity, extractToolMessageRefs } from "./tool-stream-identity.ts";

export function transcriptRunId(message: unknown): string | undefined {
  const identity = readSessionMessageIdentity(message);
  if (identity?.runId) {
    return identity.runId;
  }
  const record = asRecord(message);
  return (
    readLiveTerminalRunId(message) ??
    normalizeOptionalString(record?.runId) ??
    normalizeOptionalString(asRecord(record?.openclawStreamFallback)?.runId)
  );
}

export function isKeyedAssistantStreamFallbackMessage(message: unknown): boolean {
  return readAssistantStreamSegmentIdentity(message) !== undefined;
}

export function optionalRunIdentity(value: unknown): { runId: string } | undefined {
  const runId = normalizeOptionalString(value);
  return runId ? { runId } : undefined;
}

export function optionalBoundaryIdentity(value: unknown): { boundaryId: string } | undefined {
  const runId = normalizeOptionalString(value);
  return runId ? { boundaryId: `send:${runId}` } : undefined;
}

export function createToolCallLookup<Value>() {
  const exact = new Map<string, Value>();
  const unique = new Map<string, Value | null>();
  return {
    add(runId: string | undefined, callId: string | undefined, value: Value) {
      if (!callId) {
        return;
      }
      if (runId) {
        exact.set(buildToolStreamIdentity(runId, callId), value);
      }
      // Ambiguity belongs to each fact, not the whole call. Even equal values
      // from two occurrences cannot identify an unscoped owner.
      unique.set(callId, unique.has(callId) ? null : value);
    },
    get(runId: string | undefined, callId: string | undefined): Value | undefined {
      return callId
        ? ((runId ? exact.get(buildToolStreamIdentity(runId, callId)) : undefined) ??
            unique.get(callId) ??
            undefined)
        : undefined;
    },
  };
}

export function findCurrentTurnBounds(items: ChatItem[]): TurnInsertionBounds | null {
  const userTurn = items.findLast(
    (item) => item.kind === "message" && chatItemStartsUserTurn(item),
  );
  return userTurn ? { afterKey: userTurn.key } : null;
}

export function createRunTurnLookup(items: ChatItem[]) {
  let bounds: Map<string, TurnInsertionBounds> | undefined;
  const inputs = new Map<string, TurnInsertionBounds>();
  const pagedInputCeilings = new Map<string, TurnInsertionBounds>();
  return (runId: string, afterUserSendId?: string): TurnInsertionBounds | null => {
    if (!bounds) {
      bounds = new Map();
      let previousInput: TurnInsertionBounds | undefined;
      const open = new Map<string, TurnInsertionBounds>();
      // Accepted steers divide the transcript, not the run they continue.
      // Keep that run open, but cap unrelated runs at every user boundary.
      for (const item of items) {
        // Forwarded activity divides presentation, not the parent execution.
        // Its projected assistant role must not cap that run's live output.
        if (
          !chatItemStartsUserTurn(item) ||
          (item.kind === "message" &&
            asRecord(item.message)?.role === "assistant" &&
            isInterSessionMessage(item.message))
        ) {
          continue;
        }
        if (previousInput) {
          previousInput.beforeKey = item.key;
        }
        previousInput = { afterKey: item.key };
        const sendId =
          item.kind === "message" ? readSessionMessageIdentity(item.message)?.sendId : null;
        if (sendId) {
          inputs.set(sendId, previousInput);
        }
        const target = item.kind === "message" ? persistedSteerTargetRunId(item.message) : null;
        for (const [owner, interval] of open) {
          if (owner !== target) {
            interval.beforeKey = item.key;
            open.delete(owner);
          }
        }
        const owner = item.kind === "message" ? userTurnRunId(item.message) : null;
        for (const id of [owner, target]) {
          if (id && !bounds.has(id)) {
            const interval = { afterKey: item.key };
            bounds.set(id, interval);
            open.set(id, interval);
            if (id === target) {
              pagedInputCeilings.set(id, { beforeKey: item.key });
            }
          }
        }
      }
    }
    return (
      (afterUserSendId
        ? (inputs.get(afterUserSendId) ?? pagedInputCeilings.get(runId))
        : undefined) ??
      bounds.get(runId) ??
      null
    );
  };
}

export function resolveRunInsertionBounds(
  findRunBounds: ReturnType<typeof createRunTurnLookup>,
  runId: unknown,
  currentRunId: string | null | undefined,
  currentTurnBounds: TurnInsertionBounds | null,
): TurnInsertionBounds | null {
  if (typeof runId !== "string" || !runId.trim()) {
    return currentRunId != null ? currentTurnBounds : null;
  }
  const runBounds = findRunBounds(runId);
  if (runId === currentRunId) {
    return runBounds ?? currentTurnBounds;
  }
  if (runBounds || currentRunId == null) {
    return runBounds;
  }
  // Legacy rows may lack the user-run identity needed for exact bounds. Keep
  // them ordered before the current prompt instead of attaching them to it.
  return currentTurnBounds?.afterKey ? { beforeKey: currentTurnBounds.afterKey } : null;
}

/** A persisted invocation owns its live echo's interval even without a user send key. */
export function applyPersistedToolInvocationBounds(
  items: ChatItem[],
  tools: Array<ChatProjection<Extract<ChatItem, { kind: "message" }>>>,
): void {
  if (tools.length === 0) {
    return;
  }
  const invocations = new Map<string, TurnInsertionBounds | null>();
  let bounds: TurnInsertionBounds = {};
  for (const item of items) {
    if (item.kind === "divider") {
      invocations.clear();
    }
    if (chatItemStartsUserTurn(item) || item.kind === "divider") {
      bounds.beforeKey = item.key;
      bounds = { afterKey: item.key };
    } else if (item.kind === "message") {
      for (const ref of extractToolMessageRefs(item.message)) {
        if (!ref.runId) {
          continue;
        }
        const key = buildToolStreamIdentity(ref.runId, ref.id);
        // Reused identities on opposite sides of a user/reset remain ambiguous.
        invocations.set(
          key,
          invocations.has(key) && invocations.get(key) !== bounds ? null : bounds,
        );
      }
    }
  }
  for (const tool of tools) {
    const refs = extractToolMessageRefs(tool.item.message);
    const matching = refs.map((ref) =>
      ref.runId ? invocations.get(buildToolStreamIdentity(ref.runId, ref.id)) : undefined,
    );
    const [first] = matching;
    if (first && matching.every((candidate) => candidate === first)) {
      tool.bounds = first;
    }
  }
}
