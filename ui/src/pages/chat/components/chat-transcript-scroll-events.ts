export type TranscriptScrollObservation =
  | { type: "composer-input" }
  | { type: "composer-layout"; changed: boolean }
  | { type: "before-resize" }
  | { type: "resize"; scrollCorrection?: { before: number; after: number } }
  | { type: "input"; event: Event; touching: boolean }
  | {
      type: "offset";
      delta: number;
      scrolling: boolean;
      touching: boolean;
      programmatic: boolean;
    };

const transcriptObservers = new WeakMap<
  HTMLElement,
  Set<(event: TranscriptScrollObservation) => void>
>();

export function subscribeTranscriptScroll(
  element: HTMLElement,
  callback: (event: TranscriptScrollObservation) => void,
): () => void {
  const observers = transcriptObservers.get(element) ?? new Set();
  observers.add(callback);
  transcriptObservers.set(element, observers);
  return () => {
    observers.delete(callback);
    if (observers.size === 0) {
      transcriptObservers.delete(element);
    }
  };
}

export function publishTranscriptScroll(
  element: HTMLElement,
  event: TranscriptScrollObservation,
): void {
  for (const observer of transcriptObservers.get(element) ?? []) {
    observer(event);
  }
}
