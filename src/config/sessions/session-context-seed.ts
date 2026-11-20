import type { AgentMessage, SessionTreeEntry } from "@openclaw/agent-core";
import { estimateTokens } from "../../../packages/agent-core/src/harness/compaction/compaction-cut-point.js";
import {
  iterateSessionContextEntries,
  projectSessionContextMessage,
} from "../../../packages/agent-core/src/harness/session/session.js";
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
  const history =
    request.beforeAdmittedUser && current >= 0
      ? selected.slice(0, current)
      : selected.filter(({ message }) => !isAdmitted(message));
  // The first user turn states the goal: reserve it before cutting the suffix.
  const goal = history.findIndex(({ message }) => message.role === "user");
  const goalSize = goal >= 0 ? measure(goal) : undefined;
  function measure(index: number) {
    const message = read(history[index]!);
    return {
      bytes: Buffer.byteLength(JSON.stringify(message), "utf8"),
      tokens: estimateTokens(message),
    };
  }
  // At most the fitting suffix plus its first overflowing row is hydrated here.
  // A single oversized row and the non-discardable active input are separate from history growth.
  const cutFor = (maxBytes: number, tokenBudget: number | undefined) =>
    selectBoundedContextStart(
      history.map(({ message }) => message),
      maxBytes,
      tokenBudget,
      measure,
    );
  let cut = cutFor(request.maxBytes, request.tokenBudget);
  let keepGoal = false;
  if (goalSize && cut > goal && goalSize.bytes * 4 <= request.maxBytes) {
    cut = Math.max(
      goal + 1,
      cutFor(
        request.maxBytes - goalSize.bytes - 1,
        request.tokenBudget === undefined ? undefined : request.tokenBudget - goalSize.tokens,
      ),
    );
    keepGoal = true;
  }
  const summary = history.findLast(({ message }) => message.role === "compactionSummary");
  const omitted = history.slice(0, cut).filter((_, index) => !keepGoal || index !== goal);
  const kept = [...(keepGoal ? [history[goal]!] : []), ...history.slice(cut)];
  return {
    messages: kept.map(read),
    seed: {
      messageIds: kept.map(({ selection }) => selection.entry.id),
      omittedCount: omitted.length,
      // Entry ids are the messageIds sessions_history accepts.
      omittedIds: omitted.flatMap(({ selection, message }) =>
        message.role === "compactionSummary" ? [] : [selection.entry.id],
      ),
      ...(current >= 0 && request.beforeAdmittedUser
        ? { admittedUser: read(selected[current]!) }
        : {}),
      ...(summary ? { summary: read(summary) } : {}),
    },
  };
}
