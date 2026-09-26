import type { buildCachedChatItems } from "../chat-thread.ts";
import { assistantGroupCanOwnActiveRunStatus } from "../chat-thread.ts";

// The committed transcript owns arrivals; mounting a virtual row is not an arrival.
export class ChatMessageEntryAnimations {
  private input: ReturnType<typeof buildCachedChatItems> | null = null;
  private projected: ReadonlyMap<string, string | null> = new Map();
  private committed: ReadonlyMap<string, string | null> = new Map();
  private readonly refs = new Map<string, (element?: Element) => void>();
  private readonly seen = new Set<string>();
  private readonly pending = new Set<string>();
  private readonly active = new Map<HTMLElement, () => void>();
  private enabled = false;

  get projectedKeys(): ReadonlyMap<string, string | null> {
    return this.projected;
  }

  project(items: ReturnType<typeof buildCachedChatItems>): ReadonlyMap<string, string | null> {
    // Live text is patched in place. Keys change with structural identity,
    // so token paints do not need another history walk.
    if (this.input === items) {
      return this.projected;
    }
    const entries = new Map<string, string | null>();
    // A reply can fill the viewport before its first paint, or finalize during
    // arrival. Fading/translating that asynchronous body hides or snaps the text.
    // Only prompts have a stable submission identity throughout their arrival.
    // Other rows still anchor the order so a prepend is not mistaken for a first send.
    for (const item of items) {
      if (
        item.kind === "group" &&
        (item.role === "user" || assistantGroupCanOwnActiveRunStatus(item))
      ) {
        for (const source of item.messages) {
          entries.set(source.key, item.role === "user" ? source.key : null);
        }
      } else if (item.kind === "stream") {
        entries.set(item.key, null);
      }
    }
    this.input = items;
    this.projected = entries;
    return entries;
  }

  sync(entries: ReadonlyMap<string, string | null>, enabled: boolean): void {
    if (entries === this.committed && enabled === this.enabled) {
      return;
    }
    const keys = [...entries.keys()];
    const previousHead = keys.findIndex((key) => this.committed.has(key));
    this.pending.clear();
    for (const [index, key] of keys.entries()) {
      const identity = entries.get(key);
      if (identity == null) {
        continue;
      }
      if (
        enabled &&
        this.enabled &&
        (this.committed.size === 0 || (previousHead >= 0 && index >= previousHead)) &&
        !this.seen.has(identity)
      ) {
        this.pending.add(identity);
      }
      if (!this.refs.has(key)) {
        let current: HTMLElement | undefined;
        this.refs.set(key, (element) => {
          if (current !== element) {
            if (current) {
              this.active.get(current)?.();
            }
            current = element instanceof HTMLElement ? element : undefined;
          }
          if (current && this.pending.delete(identity)) {
            this.enter(current);
          }
        });
      }
    }
    for (const key of this.refs.keys()) {
      if (!entries.has(key)) {
        this.refs.get(key)?.(undefined);
        this.refs.delete(key);
      }
    }
    // Acknowledgement and remount are not new arrivals for a submitted prompt.
    for (const identity of entries.values()) {
      if (identity !== null) {
        this.seen.add(identity);
      }
    }
    this.committed = entries;
    this.enabled = enabled;
  }

  private enter(element: HTMLElement): void {
    this.active.get(element)?.();
    if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    const finish = () => {
      if (this.active.get(element) !== finish) {
        return;
      }
      this.active.delete(element);
      element.removeEventListener("animationend", settled);
      element.removeEventListener("animationcancel", settled);
      // A completed class otherwise replays when the retained bubble is reparented.
      element.classList.remove("chat-bubble--enter");
    };
    const settled = (event: AnimationEvent) => {
      if (event.target === element && event.animationName === "chat-message-enter") {
        finish();
      }
    };
    this.active.set(element, finish);
    element.addEventListener("animationend", settled);
    element.addEventListener("animationcancel", settled);
    element.classList.add("chat-bubble--enter");
  }

  refFor = (key: string): ((element?: Element) => void) | undefined => this.refs.get(key);
  didCommit(): void {
    this.pending.clear();
  }
  disconnect(): void {
    this.enabled = false;
    this.pending.clear();
    for (const finish of this.active.values()) {
      finish();
    }
  }
}
