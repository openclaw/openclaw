import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readTranscriptDisplayPosition } from "../../../../src/chat/transcript-display-position.js";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import {
  readSubagentCancellation,
  resolveSessionLaunchPresentation,
  subagentStopIdentity,
} from "./chat-spawned-subagent.ts";
import { buildMessageItems } from "./chat-thread-items.ts";
import { coalesceToolActivityMessages } from "./chat-tool-activity-coalesce.ts";
import { createTranscriptMemo } from "./components/chat-transcript-memo.ts";

type Position = { index: number; canonical: ReturnType<typeof readTranscriptDisplayPosition> };
const names = createTranscriptMemo<ReadonlyMap<string, string>>();

/** Derive names from loaded, earlier launch receipts without manufacturing roster rows. */
export function indexRecordedSubagentStopNames(messages: readonly unknown[]) {
  return names(messages, [], () => {
    const items = buildMessageItems([...messages]);
    const positions = new Map<string, Position>();
    for (const [index, item] of items.entries()) {
      const id = readSessionMessageIdentity(item.message)?.id;
      if (id) {
        positions.set(id, {
          index,
          canonical: readTranscriptDisplayPosition(
            asOptionalRecord(asOptionalRecord(item.message)?.["__openclaw"])?.transcriptPosition,
          ),
        });
      }
    }
    const launches: Array<{
      runId: string;
      sessionKey: string;
      label: string;
      position: Position;
    }> = [];
    const stops: Array<{
      identity: string;
      runId: string;
      sessionKey: string;
      position: Position;
    }> = [];
    for (const item of coalesceToolActivityMessages(items)) {
      if (
        item.kind !== "message" ||
        asOptionalRecord(asOptionalRecord(item.message)?.["__openclaw"])?.catalogSource === true
      ) {
        continue;
      }
      for (const card of extractToolCardsCached(item.message)) {
        const position = card.resultMessageId ? positions.get(card.resultMessageId) : undefined;
        if (!position) {
          continue;
        }
        const launch = resolveSessionLaunchPresentation(card);
        if (
          launch?.kind === "subagent" &&
          launch.phase === "succeeded" &&
          launch.runId &&
          launch.childKey &&
          launch.label
        ) {
          launches.push({
            runId: launch.runId,
            sessionKey: launch.childKey,
            label: launch.label,
            position,
          });
        }
        const stop = readSubagentCancellation(card);
        const identity = subagentStopIdentity(card);
        if (stop?.runId && stop.sessionKey && identity) {
          stops.push({ identity, runId: stop.runId, sessionKey: stop.sessionKey, position });
        }
      }
    }
    const result = new Map<string, string>();
    for (const stop of stops) {
      const labels = new Set(
        launches
          .filter((launch) => {
            if (launch.runId !== stop.runId || launch.sessionKey !== stop.sessionKey) {
              return false;
            }
            const a = launch.position.canonical,
              b = stop.position.canonical;
            return a && b && a.source === b.source
              ? a.rawSeq < b.rawSeq
              : launch.position.index < stop.position.index;
          })
          .map((launch) => launch.label),
      );
      if (labels.size === 1) {
        result.set(stop.identity, [...labels][0]!);
      }
    }
    return result;
  });
}
