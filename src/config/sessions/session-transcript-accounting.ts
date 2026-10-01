import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import {
  deriveContextPromptTokens,
  hasNonzeroUsage,
  normalizeUsage,
  type UsageLike,
} from "../../agents/usage.js";
import { withRecentSessionTranscriptActiveEventsInSnapshot } from "./session-accessor.sqlite-active-events.js";
import type { CurrentTranscriptProjection } from "./session-accessor.sqlite-projection-read.js";
import { readVisibleTranscriptStats } from "./session-accessor.sqlite-reset-window.js";
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
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return;
    }
    const record = event as { message?: unknown; type?: unknown; usage?: UsageLike };
    const message =
      record.message && typeof record.message === "object" && !Array.isArray(record.message)
        ? (record.message as AgentMessage & { api?: unknown; usage?: UsageLike })
        : undefined;
    if (scanUsage) {
      const rawUsage = message?.usage ?? record.usage;
      if (
        record.type === "compaction" ||
        record.type === "reset" ||
        (message?.api === "cli" && rawUsage && rawUsage.contextUsage === undefined)
      ) {
        scanUsage = false;
        trailingMessages.length = 0;
      } else {
        const usage = normalizeUsage(rawUsage);
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
        const metadata = (message as { __openclaw?: unknown })["__openclaw"];
        if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
          const openClaw = metadata as { resultContentSource?: unknown; turnTainted?: unknown };
          if (openClaw.turnTainted === true || openClaw.resultContentSource === "network") {
            tainted = true;
            scanTaint = false;
          }
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

export function readSessionTranscriptAccountingFromProjection(
  projection: CurrentTranscriptProjection,
  params: SessionTranscriptAccountingOptions,
): SessionTranscriptAccountingSnapshot {
  const snapshot: SessionTranscriptAccountingSnapshot = {};
  try {
    if (params.includeByteSize) {
      const stats = readVisibleTranscriptStats(projection);
      snapshot.byteSize = stats.sizeBytes;
      snapshot.eventCount = stats.eventCount;
    }
    if (params.includeUsage || params.includeTurnTaint) {
      const accounting = withRecentSessionTranscriptActiveEventsInSnapshot(
        projection,
        params.usageEventLimit ?? SQLITE_USAGE_TAIL_MAX_EVENTS,
        (visit) => {
          const result = readTranscriptAccountingSnapshot(visit, params);
          if (!result.hasLeafControl) {
            return result;
          }
          // First-row and legacy flat projections can still contain leaf controls.
          // Preserve their serialized navigation contract in this same snapshot.
          const events: unknown[] = [];
          visit((event) => events.push(event));
          events.reverse();
          const activeEvents = selectSessionTranscriptLeafControlledPath(events) ?? events;
          return {
            ...readTranscriptAccountingSnapshot((visitor) => {
              for (let index = activeEvents.length - 1; index >= 0; index -= 1) {
                visitor(activeEvents[index]);
              }
            }, params),
            eventCount: result.eventCount,
          };
        },
      );
      if (params.includeUsage) {
        snapshot.usage = accounting.usage;
      }
      if (params.includeTurnTaint) {
        snapshot.turnTainted =
          accounting.tainted ||
          (!accounting.boundaryFound && accounting.eventCount >= SQLITE_USAGE_TAIL_MAX_EVENTS);
      }
    }
  } catch {
    if (params.includeTurnTaint) {
      snapshot.turnTainted = true;
    }
  }
  return snapshot;
}
