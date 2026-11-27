import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import { deriveContextPromptTokens, hasNonzeroUsage, normalizeUsage } from "../../agents/usage.js";
import {
  SQLITE_USAGE_TAIL_MAX_EVENTS,
  type SessionTranscriptAccountingOptions,
  type SessionTranscriptAccountingSnapshot,
  type SessionTranscriptUsageSnapshot,
} from "./session-transcript-accounting.types.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptActiveEntries,
} from "./transcript-tree.js";

function isUnavailableContextBarrier(
  usage: NonNullable<ReturnType<typeof normalizeUsage>>,
): boolean {
  if (usage.contextUsage?.state !== "unavailable") {
    return false;
  }
  return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.total].every(
    (value) => !(typeof value === "number" && value > 0),
  );
}

function deriveTranscriptUsageSnapshot(
  usage: NonNullable<ReturnType<typeof normalizeUsage>>,
  trailingMessages: AgentMessage[],
): SessionTranscriptUsageSnapshot | undefined {
  const promptTokens = deriveContextPromptTokens({ lastCallUsage: usage });
  // Counters can cover a whole multi-call turn; the context marker keeps the latest call.
  const outputTokens = asPositiveFiniteNumber(
    usage.contextUsage?.state === "available"
      ? usage.contextUsage.totalTokens - usage.contextUsage.promptTokens
      : usage.output,
  );
  if (!(typeof promptTokens === "number") && !(typeof outputTokens === "number")) {
    return undefined;
  }
  return {
    promptTokens,
    outputTokens,
    trailingMessages,
  };
}

function readTranscriptAccountingSnapshot(
  events: Iterable<unknown>,
  options: { includeUsage: boolean; includeTurnTaint?: boolean },
): {
  boundaryFound: boolean;
  tainted: boolean;
  usage?: SessionTranscriptUsageSnapshot;
} {
  let scanUsage = options.includeUsage;
  let scanTaint = options.includeTurnTaint === true;
  let latestUsage: ReturnType<typeof normalizeUsage>;
  const trailingMessages: AgentMessage[] = [];
  let boundaryFound = false;
  let tainted = false;
  for (const event of events) {
    const record = asOptionalRecord(event);
    if (!record) {
      continue;
    }
    const messageRecord = asOptionalRecord(record.message);
    // SAFETY: Stored message payloads use the AgentMessage serialization contract.
    const message = messageRecord as AgentMessage | undefined;
    if (scanUsage) {
      const rawUsage = messageRecord?.usage ?? record.usage;
      const usageFields = asOptionalRecord(rawUsage);
      if (
        record.type === "compaction" ||
        record.type === "reset" ||
        (messageRecord?.api === "cli" && rawUsage && usageFields?.contextUsage === undefined)
      ) {
        scanUsage = false;
        trailingMessages.length = 0;
      } else {
        const usage = normalizeUsage(usageFields);
        if (usage && isUnavailableContextBarrier(usage)) {
          scanUsage = false;
          trailingMessages.length = 0;
        } else if (usage && hasNonzeroUsage(usage)) {
          latestUsage = usage;
          scanUsage = false;
        } else if (message) {
          trailingMessages.push(message);
        }
      }
    }
    if (scanTaint && message) {
      if (message.role === "user") {
        boundaryFound = true;
        scanTaint = false;
      } else {
        const metadata = asOptionalRecord(messageRecord?.["__openclaw"]);
        if (metadata?.turnTainted === true || metadata?.resultContentSource === "network") {
          tainted = true;
          scanTaint = false;
        }
      }
    }
    if (!scanUsage && !scanTaint) {
      break;
    }
  }
  return {
    boundaryFound,
    tainted,
    usage: latestUsage
      ? deriveTranscriptUsageSnapshot(latestUsage, trailingMessages.toReversed())
      : undefined,
  };
}

/** Select navigation before reading bodies: an older control can change the apparent tail. */
export function selectSessionTranscriptAccountingTail<T>(
  entries: readonly T[],
  recordOf: (entry: T) => unknown,
): readonly T[] {
  const tree = scanSessionTranscriptTree(entries.map(recordOf));
  return tree.hasLeafControl
    ? selectSessionTranscriptActiveEntries({ entries, recordOf, tree })
    : entries;
}

/** Consume only the required newest-first suffix of an already selected bounded path. */
export function readSessionTranscriptAccountingTail(
  events: Iterable<unknown>,
  options: SessionTranscriptAccountingOptions,
  candidateCount: number,
): SessionTranscriptAccountingSnapshot {
  const accounting = readTranscriptAccountingSnapshot(events, options);
  return {
    ...(options.includeUsage ? { usage: accounting.usage } : {}),
    ...(options.includeTurnTaint
      ? {
          turnTainted:
            accounting.tainted ||
            (!accounting.boundaryFound && candidateCount >= SQLITE_USAGE_TAIL_MAX_EVENTS),
        }
      : {}),
  };
}
