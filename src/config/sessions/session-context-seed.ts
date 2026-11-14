import type { AgentMessage, SessionTreeEntry } from "@openclaw/agent-core";
import { estimateTokens } from "../../../packages/agent-core/src/harness/compaction/compaction-cut-point.js";
import {
  iterateSessionContextEntries,
  projectSessionContextMessage,
} from "../../../packages/agent-core/src/harness/session/session.js";
import { estimateCompactionHistoryTokens } from "../../agents/sessions/context-token-pressure.js";
import { selectBoundedContextStart } from "./session-bounded-context-selection.js";
import type {
  SessionContextSeedRequest,
  SessionTranscriptContextSnapshot,
} from "./session-history-read.types.js";

/** Native seed selection shares the model-view cut without changing full-fidelity readers. */
export function readSessionContextSeed<T extends SessionTreeEntry>(
  entries: readonly T[],
  request: SessionContextSeedRequest,
  readEntry: (entry: T) => SessionTreeEntry = (entry) => entry,
): Pick<SessionTranscriptContextSnapshot, "messages" | "seed"> {
  const selected = Array.from(iterateSessionContextEntries(entries)).flatMap((selection) => {
    const message = projectSessionContextMessage(selection);
    return message ? [{ selection, message }] : [];
  });
  const hydrated = new Map<(typeof selected)[number], AgentMessage>();
  const read = (item: (typeof selected)[number]): AgentMessage => {
    let message = hydrated.get(item);
    if (!message) {
      message = projectSessionContextMessage(item.selection, readEntry);
      if (!message) {
        throw new Error("Session seed navigation disagrees with its message payload");
      }
      hydrated.set(item, message);
    }
    return message;
  };
  const isAdmitted = (message: AgentMessage) =>
    message.role === "user" &&
    Boolean(request.admittedKey) &&
    Reflect.get(message, "idempotencyKey") === request.admittedKey;
  const current = selected.findIndex(({ message }) => isAdmitted(message));
  const retainedInputTokens = estimateCompactionHistoryTokens(
    current < 0 ? [] : selected.slice(current).map(read),
  );
  const history =
    request.beforeAdmittedUser && current >= 0
      ? selected.slice(0, current)
      : selected.filter(({ message }) => !isAdmitted(message));
  // At most the fitting suffix plus its first overflowing row is hydrated here.
  // A single oversized row and the non-discardable active input are separate from history growth.
  const cut = selectBoundedContextStart(
    history.map(({ message }) => message),
    request.maxBytes,
    request.tokenBudget,
    (index) => {
      const message = read(history[index]!);
      return {
        bytes: Buffer.byteLength(JSON.stringify(message), "utf8"),
        tokens: estimateTokens(message),
      };
    },
  );
  const summary = history.findLast(({ message }) => message.role === "compactionSummary");
  return {
    messages: history.slice(cut).map(read),
    seed: {
      omittedCount: cut,
      omittedNonSummary: history
        .slice(0, cut)
        .some(({ message }) => message.role !== "compactionSummary"),
      retainedInputTokens,
      ...(current >= 0 && request.beforeAdmittedUser
        ? { admittedUser: read(selected[current]!) }
        : {}),
      ...(summary ? { summary: read(summary) } : {}),
    },
  };
}
