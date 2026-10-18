import { createContext } from "solid-js";

type MessageElementRef = (element?: Element) => void;

/** The transcript's bubble refs are shared by navigation and selection. */
export class TranscriptMessageElements {
  private readonly mounted = new Map<string, HTMLElement>();
  private readonly refs = new Map<string, MessageElementRef>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly entryRefFor: (key: string) => MessageElementRef | undefined) {}

  get elements(): ReadonlyMap<string, HTMLElement> {
    return this.mounted;
  }

  forKey = (key: string): MessageElementRef => {
    let ref = this.refs.get(key);
    if (!ref) {
      ref = (element) => {
        this.entryRefFor(key)?.(element);
        const previous = this.mounted.get(key);
        const current = element instanceof HTMLElement ? element : undefined;
        if (current) {
          this.mounted.set(key, current);
        } else {
          this.mounted.delete(key);
          this.refs.delete(key);
        }
        if (previous !== current) {
          for (const listener of this.listeners) {
            listener();
          }
        }
      };
      this.refs.set(key, ref);
    }
    return ref;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  dispose(): void {
    this.mounted.clear();
    this.refs.clear();
    this.listeners.clear();
  }
}

export const TranscriptMessageElementsContext = createContext<TranscriptMessageElements | null>(
  null,
);
