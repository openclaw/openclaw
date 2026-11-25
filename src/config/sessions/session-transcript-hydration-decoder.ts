import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import type { PreparedSessionTranscriptHydration } from "./session-history-read.types.js";
import type {
  SessionTranscriptHydrationChunk,
  SessionTranscriptHydrationWorkerResult,
} from "./session-transcript-hydration.types.js";

/** One read owns its decoded graph, whether consumed in the worker or on the host. */
export function createSessionTranscriptHydrationDecoder(options: {
  includeEventJson?: boolean;
  selected?: boolean;
}) {
  const events: TranscriptEvent[] = [];
  const eventJson: string[] | undefined = options.includeEventJson ? [] : undefined;
  const eventSeqs: number[] | undefined =
    options.includeEventJson || options.selected ? [] : undefined;
  const parts: Uint8Array[] = [];
  let decoder: TextDecoder | undefined;
  return {
    accept(value: SessionTranscriptHydrationChunk): void {
      decoder ??= new TextDecoder(value.encoding, { ignoreBOM: true });
      for (const frame of value.frames) {
        parts.push(frame.data);
        if (frame.endOfEvent) {
          const json = decoder.decode(parts.length === 1 ? parts[0] : Buffer.concat(parts));
          events.push(JSON.parse(json));
          eventJson?.push(json);
          if (eventSeqs) {
            if (typeof frame.seq !== "number" || !Number.isSafeInteger(frame.seq)) {
              throw new Error("Transcript snapshot omitted its row sequence");
            }
            eventSeqs.push(frame.seq);
          }
          parts.length = 0;
        }
      }
    },
    finish(
      value: SessionTranscriptHydrationWorkerResult,
      onSourceRows?: (events: readonly TranscriptEvent[], sequences: readonly number[]) => void,
    ): PreparedSessionTranscriptHydration {
      if (value.kind === "bounded") {
        return value;
      }
      if (parts.length !== 0 || events.length !== value.eventCount) {
        throw new Error("Session history worker returned an incomplete transcript");
      }
      if (value.kind === "streamed-bounded") {
        const bySequence = new Map(eventSeqs!.map((seq, index) => [seq, events[index]!]));
        if (
          bySequence.size !== value.eventCount ||
          new Set(value.sequences).size !== value.eventCount ||
          value.sequences.some((seq) => !bySequence.has(seq))
        ) {
          throw new Error("Session history worker returned an incomplete selected transcript");
        }
        const selectedEvents = value.sequences.map((seq) => bySequence.get(seq)!);
        onSourceRows?.(selectedEvents, value.sequences);
        return {
          kind: "bounded",
          snapshot: {
            ...value.snapshot,
            events: selectedEvents,
          },
          residentRows: value.residentRows,
          ...(value.transcript ? { transcript: value.transcript } : {}),
          ...(value.compaction ? { compaction: value.compaction } : {}),
        };
      }
      if (onSourceRows && eventSeqs) {
        onSourceRows(events, eventSeqs);
      }
      return {
        kind: "full",
        snapshot: {
          events,
          version: value.version,
          ...(eventJson ? { eventJson, eventSeqs } : {}),
        },
      };
    },
  };
}
