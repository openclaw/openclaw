import { createContext } from "solid-js";

type MessageElementRef = (element?: Element) => void;

/** The transcript's bubble refs are shared by navigation and selection. */
export function createTranscriptMessageElements(
  entryRefFor: (key: string) => MessageElementRef | undefined,
) {
  const mounted = new Map<string, HTMLElement>();
  const listeners = new Set<() => void>();
  return {
    get elements(): ReadonlyMap<string, HTMLElement> {
      return mounted;
    },
    forKey:
      (key: string): MessageElementRef =>
      (element) => {
        entryRefFor(key)?.(element);
        const previous = mounted.get(key);
        const current = element instanceof HTMLElement ? element : undefined;
        if (current) {
          mounted.set(key, current);
        } else {
          mounted.delete(key);
        }
        if (previous !== current) {
          for (const listener of listeners) {
            listener();
          }
        }
      },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose(): void {
      mounted.clear();
      listeners.clear();
    },
  };
}

export type TranscriptMessageElements = ReturnType<typeof createTranscriptMessageElements>;

export const TranscriptMessageElementsContext = createContext<TranscriptMessageElements | null>(
  null,
);
