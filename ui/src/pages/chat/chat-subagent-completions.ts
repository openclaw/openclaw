import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  unwrapToolCallForDisplay,
  unwrapToolResultTextForDisplay,
} from "../../../../src/agents/tool-display-call.js";
import { isToolResultContentType } from "../../../../src/chat/tool-content.js";
import {
  messageSubagentCompletions,
  readSubagentCompletions,
  readCollectedSubagentCompletions,
  subagentCompletionMessage,
} from "../../../../src/shared/subagent-completion.js";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { getMessageDerivations } from "../../lib/chat/message-derivations.ts";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import {
  insertChatItemsByTimestamp,
  rawMessageTimestamp,
  isPendingSendMessage,
  resolveToolBlockId,
  type ChatProjection,
} from "./chat-thread-items.ts";
import { transcriptRunId } from "./chat-thread-run-identity.ts";
import { chatItemStartsUserTurn } from "./chat-turn-boundary.ts";

/** Read the result before call/result coalescing moves it to the invocation's start. */
export function projectSubagentCompletions(
  source: ChatItem[],
  showToolCalls: boolean,
  hidden?: Set<string>,
  matchesSearch?: (message: unknown) => boolean,
): ChatItem[] {
  if (!showToolCalls) {
    // Hidden receipts hand a settle wake's continuation to the resumed row.
    let continuation: unknown;
    return source.flatMap((item): ChatItem[] => {
      if (item.kind !== "message") {
        return [item];
      }
      const metadata = asOptionalRecord(asOptionalRecord(item.message)?.["__openclaw"]);
      if (messageSubagentCompletions(item.message).length) {
        continuation ??= metadata?.continuation;
        return [];
      }
      if (!continuation) {
        return [item];
      }
      const message = {
        ...asOptionalRecord(item.message),
        __openclaw: { ...metadata, continuation },
      };
      continuation = undefined;
      return [{ ...item, message }];
    });
  }
  const items = source;
  const inserts: ChatProjection[] = [];
  for (const [index, item] of items.entries()) {
    if (item.kind !== "message") {
      continue;
    }
    const raw = asOptionalRecord(item.message);
    if (asOptionalRecord(raw?.["__openclaw"])?.catalogSource === true) {
      continue;
    }
    if (raw?.["__openclawToolStreamLive"] && raw["__openclawToolStreamResultReceived"] !== true) {
      continue;
    }
    if (!raw) {
      continue;
    }
    const derivations = getMessageDerivations(raw);
    const completedItems = (derivations.completedSubagentItems ??= (() => {
      const completed: Array<{ key: string; message: unknown }> = [];
      const blocks = Array.isArray(raw.content)
        ? raw.content.map(asOptionalRecord).filter((block) => isToolResultContentType(block?.type))
        : [];
      for (const card of extractToolCardsCached(item.message)) {
        if (unwrapToolCallForDisplay(card).name !== "agents_wait") {
          continue;
        }
        const matches = blocks.filter(
          (block) =>
            block &&
            (card.callId
              ? resolveToolBlockId(block, raw) === card.callId
              : block.name === card.name),
        );
        if (blocks.length && matches.length !== 1) {
          continue;
        }
        const retained = readSubagentCompletions(
          matches[0]?.subagentCompletions ?? raw.subagentCompletions,
        );
        const completions = retained.length
          ? retained
          : readCollectedSubagentCompletions({
              details: card.details,
              content: [
                { type: "text", text: unwrapToolResultTextForDisplay(card.outputText ?? "") },
              ],
            });
        if (!completions.length) {
          continue;
        }
        const timestamp = matches[0]?.timestamp ?? raw.timestamp;
        if (typeof timestamp !== "number") {
          continue;
        }
        const key = "subagent-finished:" + item.key + ":" + (card.callId ?? card.id);
        const message = subagentCompletionMessage(item.message, completions, {
          timestamp,
          derived: true,
        });
        message["__openclaw"] = { ...message["__openclaw"], id: key };
        completed.push({ key, message });
      }
      return completed;
    })());
    if (!completedItems.length) {
      continue;
    }
    for (const completed of completedItems) {
      if (hidden?.has(item.key) && !matchesSearch?.(completed.message)) {
        hidden.add(completed.key);
      }
      let afterKey = item.key;
      let beforeKey: string | undefined;
      const completedAt = rawMessageTimestamp(completed.message)!;
      for (const next of items.slice(index + 1)) {
        if (!chatItemStartsUserTurn(next)) {
          continue;
        }
        if (next.kind === "message" && isPendingSendMessage(next.message)) {
          beforeKey = next.key;
          break;
        }
        const timestamp =
          next.kind === "message"
            ? rawMessageTimestamp(next.message)
            : next.kind === "notice"
              ? next.timestamp
              : null;
        if (timestamp !== null && timestamp <= completedAt) {
          afterKey = next.key;
        } else {
          beforeKey = next.key;
          break;
        }
      }
      inserts.push({
        item: { kind: "message", ...completed },
        bounds: { afterKey, ...(beforeKey ? { beforeKey } : {}) },
      });
    }
  }
  insertChatItemsByTimestamp(items, inserts);
  const seen = new Set<string>();
  const projected: ChatItem[] = [];
  for (const item of items) {
    if (item.kind !== "message") {
      projected.push(item);
      continue;
    }
    const completions = messageSubagentCompletions(item.message);
    if (!completions.length) {
      projected.push(item);
      continue;
    }
    const fresh = completions.filter((completion) => {
      const key = JSON.stringify([completion.sessionKey, completion.runId]);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
    if (!fresh.length) {
      continue;
    }
    const previous = projected.at(-1);
    const earlier =
      previous?.kind === "message" ? messageSubagentCompletions(previous.message) : [];
    if (
      previous?.kind === "message" &&
      earlier.length &&
      hidden?.has(previous.key) === hidden?.has(item.key) &&
      transcriptRunId(previous.message) === transcriptRunId(item.message)
    ) {
      const owner = asOptionalRecord(previous.message)!;
      const derivations = getMessageDerivations(owner);
      const cached = derivations.completedSubagentGroup;
      const sources = [previous.message, item.message];
      const completionsKey = JSON.stringify(
        fresh.map(({ runId, sessionKey }) => [runId, sessionKey]),
      );
      const message =
        cached &&
        cached.completionsKey === completionsKey &&
        cached.sources.every((candidate, index) => candidate === sources[index])
          ? cached.message
          : subagentCompletionMessage(previous.message, [...earlier, ...fresh]);
      derivations.completedSubagentGroup = { sources, completionsKey, message };
      projected[projected.length - 1] = { ...previous, message };
    } else {
      projected.push(
        fresh.length === completions.length
          ? item
          : {
              ...item,
              message: subagentCompletionMessage(item.message, fresh),
            },
      );
    }
  }
  return projected;
}
