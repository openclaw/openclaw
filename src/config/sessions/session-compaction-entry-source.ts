import {
  estimateTokens,
  getMessageFromEntryForCompaction,
} from "../../../packages/agent-core/src/harness/compaction/compaction-cut-point.js";
import type { CompactionEntrySource } from "../../../packages/agent-core/src/harness/compaction/compaction-entry-source.js";
import type { CompactionContextProjection } from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import {
  prepareFileOperationMessage,
  prepareConversationMessage,
} from "../../../packages/agent-core/src/harness/compaction/utils.js";
import { convertToLlm } from "../../../packages/agent-core/src/harness/messages.js";
import { iterateSessionContextMessages } from "../../../packages/agent-core/src/harness/session/session.js";
import { selectResetKeptEntries } from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import { prepareSafeguardMessage } from "../../agents/agent-hooks/compaction-safeguard-source.js";
import { sanitizeCompactionMessages } from "../../agents/compaction-planning.js";
import { estimateCompactionHistoryTokens } from "../../agents/sessions/compaction/request-budget.js";
import type { CompactionRequestBudget } from "../../agents/sessions/compaction/request-budget.types.js";
import type { TranscriptContextSnapshot } from "./session-accessor.sqlite-model-context.js";

/** Compaction consumes the replay owner's navigation and full-fidelity lazy reads. */
export function createSessionCompactionEntrySource(
  snapshot: TranscriptContextSnapshot,
  budget?: CompactionRequestBudget,
) {
  const { entries } = snapshot;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const measured = new WeakMap<AgentMessage, number>();
  const prepare = (message: AgentMessage, shell: AgentMessage) => {
    const tokens = estimateTokens(message);
    measured.set(message, tokens);
    const llm = convertToLlm(sanitizeCompactionMessages([message]))[0];
    return {
      tokens: budget ? estimateCompactionHistoryTokens([message], budget) : tokens,
      fileOperations: prepareFileOperationMessage(message),
      safeguard: prepareSafeguardMessage(
        message,
        llm ? prepareConversationMessage(llm) : undefined,
        shell,
      ),
    };
  };
  const facts = new Map<string, ReturnType<typeof prepare> | undefined>();
  const readEntry: TranscriptContextSnapshot["readEntry"] = (navigation) => {
    const entry = snapshot.readEntry(navigation);
    if (!facts.has(entry.id)) {
      const message = getMessageFromEntryForCompaction(entry);
      facts.set(
        entry.id,
        message
          ? prepare(message, getMessageFromEntryForCompaction(navigation) ?? message)
          : undefined,
      );
    }
    return entry;
  };
  const getFacts = (id: string | undefined) => {
    const entry = id ? byId.get(id) : undefined;
    if (entry && !facts.has(entry.id)) {
      readEntry(entry);
    }
    return entry ? facts.get(entry.id) : undefined;
  };
  const source: CompactionEntrySource = {
    length: entries.length,
    metadata: (index) => entries[index],
    tokens: (index) => getFacts(entries[index]?.id)?.tokens ?? 0,
    fileOperations: (index) => getFacts(entries[index]?.id)?.fileOperations,
    get(index) {
      const entry = entries[index];
      return entry ? readEntry(entry) : undefined;
    },
  };
  const context: CompactionContextProjection = {
    messages: () => iterateSessionContextMessages(entries, readEntry),
    estimateTokens: (message) => measured.get(message) ?? estimateTokens(message),
    resetKeptEntryIndices(startIndex, endIndex) {
      const retained = new Set(selectResetKeptEntries(entries.slice(startIndex, endIndex)));
      const indices: number[] = [];
      for (let i = startIndex; i < endIndex; i++) {
        if (retained.has(entries[i]!)) {
          indices.push(i);
        }
      }
      return indices;
    },
  };
  return { source, context, getFacts };
}
