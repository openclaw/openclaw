import { noChange, type ChildPart } from "lit";
import {
  clearPart,
  getCommittedValue,
  insertPart,
  removePart,
  setChildPartValue,
  setCommittedValue,
} from "lit/directive-helpers.js";
import { Directive, directive } from "lit/directive.js";
import { repeat } from "lit/directives/repeat.js";

type KeyedEntry = { key: unknown; value: unknown };

class AtomicKeyedRepeatDirective extends Directive {
  private parts = new Map<unknown, ChildPart>();
  private committedParts?: ChildPart[];

  render(_entries: readonly KeyedEntry[]) {
    return noChange;
  }

  override update(container: ChildPart, [entries]: [readonly KeyedEntry[]]) {
    if (getCommittedValue(container) !== this.committedParts) {
      clearPart(container);
      this.parts.clear();
    }
    const next = new Map<unknown, ChildPart>();
    for (const { key, value } of entries) {
      const part = this.parts.get(key) ?? insertPart(container);
      setChildPartValue(part, value);
      next.set(key, part);
    }
    for (const [key, part] of this.parts) {
      if (!next.has(key)) {
        removePart(part);
      }
    }
    const ordered = [...next.values()];
    let before: ChildPart | undefined;
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const part = ordered[index]!;
      const reference = before?.startNode ?? container.endNode;
      const parent = part.startNode!.parentNode;
      if (part.endNode!.nextSibling !== reference) {
        if (
          parent instanceof Element &&
          parent.isConnected &&
          typeof parent.moveBefore === "function"
        ) {
          // All parts keep one Lit parent; only their connected DOM order changes.
          const after = part.endNode!.nextSibling;
          let node: Node | null = part.startNode;
          while (node !== after) {
            const following: Node | null = node!.nextSibling;
            parent.moveBefore(node!, reference);
            node = following;
          }
        } else {
          insertPart(container, before, part);
        }
      }
      before = part;
    }
    this.parts = next;
    this.committedParts = ordered;
    setCommittedValue(container, ordered);
    return noChange;
  }
}

const atomicKeyedRepeatDirective = directive(AtomicKeyedRepeatDirective);

export function atomicKeyedRepeat<T>(
  items: readonly T[],
  keyFor: (item: T) => unknown,
  render: (item: T, index: number) => unknown,
) {
  if (typeof Element.prototype.moveBefore !== "function") {
    return repeat(items, keyFor, render);
  }
  return atomicKeyedRepeatDirective(
    items.map((item, index) => ({ key: keyFor(item), value: render(item, index) })),
  );
}
