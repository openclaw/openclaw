import { createContext } from "solid-js";

type MessageElementRef = (element?: Element) => void;

/** The transcript's bubble refs are shared by navigation and selection. */
export function createTranscriptMessageElements(
  entryRefFor: (key: string) => MessageElementRef | undefined,
) {
  const mounted = new Map<string, HTMLElement>();
  let changed: (() => void) | undefined;
  return {
    get elements(): ReadonlyMap<string, HTMLElement> {
      return mounted;
    },
    forKey(key: string): MessageElementRef {
      let registered: HTMLElement | undefined;
      return (element) => {
        const previous = mounted.get(key);
        const current = element instanceof HTMLElement ? element : undefined;
        // A replacement branch can mount before the previous branch cleans up.
        if (!current && previous !== registered) {
          return;
        }
        registered = current;
        entryRefFor(key)?.(element);
        if (current) {
          mounted.set(key, current);
        } else {
          mounted.delete(key);
        }
        if (previous !== current) {
          changed?.();
        }
      };
    },
    subscribe(listener: () => void): () => void {
      changed = listener;
      return () => {
        changed = undefined;
      };
    },
    dispose(): void {
      mounted.clear();
      changed = undefined;
    },
  };
}

export type TranscriptMessageElements = ReturnType<typeof createTranscriptMessageElements>;

export const TranscriptMessageElementsContext = createContext<TranscriptMessageElements | null>(
  null,
);
