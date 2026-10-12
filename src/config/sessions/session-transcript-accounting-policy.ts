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
  isSessionTranscriptLeafControl,
  selectSessionTranscriptLeafControlledPath,
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
  const outputTokens = asPositiveFiniteNumber(usage.output);
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
  visit: (visitor: (event: unknown) => void) => void,
  options: { includeUsage: boolean; includeTurnTaint?: boolean },
): {
  boundaryFound: boolean;
  eventCount: number;
  hasLeafControl: boolean;
  tainted: boolean;
  usage?: SessionTranscriptUsageSnapshot;
} {
  let scanUsage = options.includeUsage;
  let scanTaint = options.includeTurnTaint === true;
  let latestUsage: ReturnType<typeof normalizeUsage>;
  const trailingMessages: AgentMessage[] = [];
  let boundaryFound = false;
  let tainted = false;
  let eventCount = 0;
  let hasLeafControl = false;
  visit((event) => {
    eventCount += 1;
    hasLeafControl ||= isSessionTranscriptLeafControl(event);
    const record = asOptionalRecord(event);
    if (!record) {
      return;
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
  });
  return {
    boundaryFound,
    eventCount,
    hasLeafControl,
    tainted,
    usage: latestUsage
      ? deriveTranscriptUsageSnapshot(latestUsage, trailingMessages.toReversed())
      : undefined,
  };
}

/** Both backends visit the bounded active tail newest first. */
export function readSessionTranscriptAccountingTail(
  visit: (visitor: (event: unknown) => void) => void,
  options: SessionTranscriptAccountingOptions,
): SessionTranscriptAccountingSnapshot {
  let accounting = readTranscriptAccountingSnapshot(visit, options);
  if (accounting.hasLeafControl) {
    // Imported flat transcripts can still contain serialized navigation controls.
    const events: unknown[] = [];
    visit((event) => events.push(event));
    events.reverse();
    const active = selectSessionTranscriptLeafControlledPath(events) ?? events;
    accounting = {
      ...readTranscriptAccountingSnapshot((visitor) => {
        for (let index = active.length - 1; index >= 0; index -= 1) {
          visitor(active[index]);
        }
      }, options),
      eventCount: accounting.eventCount,
    };
  }
  return {
    ...(options.includeUsage ? { usage: accounting.usage } : {}),
    ...(options.includeTurnTaint
      ? {
          turnTainted:
            accounting.tainted ||
            (!accounting.boundaryFound && accounting.eventCount >= SQLITE_USAGE_TAIL_MAX_EVENTS),
        }
      : {}),
  };
}
