import { onTestFinished } from "vitest";
import {
  subscribeTranscriptScroll,
  type TranscriptNativeScroll,
  type TranscriptScrollObservation,
} from "./chat-transcript-scroll-events.ts";

export function readerScroll(
  scrollTop: number,
  delta: number,
  clientHeight = 200,
  scrollHeight = 1000,
): TranscriptNativeScroll {
  return {
    viewport: { scrollTop, clientHeight, scrollHeight },
    delta,
    programmatic: false,
    maintenance: false,
  };
}

export function recordOffsets<T>(
  element: HTMLDivElement,
  project: (event: Extract<TranscriptScrollObservation, { type: "offset" }>) => T,
) {
  const events: T[] = [];
  onTestFinished(
    subscribeTranscriptScroll(element, (event) => {
      if (event.type === "offset") {
        events.push(project(event));
      }
    }),
  );
  return events;
}
