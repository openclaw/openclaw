import { invertedEffects } from "@codemirror/commands";
import { EditorSelection, EditorState, MapMode, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { render } from "@solidjs/web";
import type { ApplicationContext } from "../../../app/context-types.ts";
import { PersonReferenceLabel } from "../../../components/solid/person-reference-label.tsx";
import type { HumanMention } from "../../../lib/chat/chat-types.ts";
import { ApplicationProvider } from "../../../lib/reactive/context.ts";

const chipDisposers = new WeakMap<HTMLElement, () => void>();
/** The whole selected mention renders as one atomic chip, exactly like a sent
 * reference. Its raw @Name text stays in the document for submission/clipboard. */
export class MentionChip extends WidgetType {
  constructor(
    readonly profileId: string,
    readonly label: string,
    readonly application: ApplicationContext | undefined,
    readonly avatarUrl?: string,
  ) {
    super();
  }
  override eq(other: MentionChip) {
    return (
      other.profileId === this.profileId &&
      other.label === this.label &&
      other.avatarUrl === this.avatarUrl
    );
  }
  toDOM() {
    const node = document.createElement("span");
    node.className = "markdown-person-reference chat-composer-mention";
    node.dataset.profileId = this.profileId;
    // Provide the capability in this separate root; CM owns its lifetime.
    const label = () => (
      <PersonReferenceLabel
        profileId={this.profileId}
        label={this.label}
        avatarUrl={this.avatarUrl}
      />
    );
    chipDisposers.set(
      node,
      render(
        () =>
          this.application ? (
            <ApplicationProvider value={this.application}>{label()}</ApplicationProvider>
          ) : (
            label()
          ),
        node,
      ),
    );
    return node;
  }
  override destroy(node: HTMLElement) {
    chipDisposers.get(node)?.();
    chipDisposers.delete(node);
  }
  override ignoreEvent() {
    return false;
  }
}

// The protocol requires a boundary around "@Name". Typing straight against an
// atomic chip inserts that separator instead of silently dissolving the chip.
const MENTION_BEFORE = /[\p{L}\p{N}\p{M}_@.%+-]$/u;
const MENTION_AFTER = /^[\p{L}\p{N}\p{M}_-]/u;
export const separateTypedTextFromMentions = EditorState.transactionFilter.of((transaction) => {
  if (
    !transaction.docChanged ||
    (!transaction.isUserEvent("input") && !transaction.isUserEvent("delete")) ||
    transaction.isUserEvent("input.type.compose")
  ) {
    return transaction;
  }
  const chips = transaction.startState.field(mentionDecorations, false);
  if (!chips || chips.size === 0) {
    return transaction;
  }
  // Typing the separator we inserted steps over it instead of doubling it.
  const typed = transaction.startState.selection.main;
  let insertedText = "";
  transaction.changes.iterChanges((_fromA, _toA, _fromB, _toB, text) => {
    insertedText += text.toString();
  });
  if (
    transaction.isUserEvent("input.type") &&
    typed.empty &&
    typed.head > 0 &&
    (insertedText === "'" || insertedText === "’") &&
    transaction.startState.sliceDoc(typed.head - 1, typed.head) === " "
  ) {
    let chipPrecedes = false;
    chips.between(typed.head - 1, typed.head - 1, (_from, to) => {
      chipPrecedes ||= to === typed.head - 1;
    });
    if (chipPrecedes) {
      return [
        transaction,
        {
          changes: { from: typed.head - 1, to: typed.head },
          sequential: true,
          selection: EditorSelection.cursor(typed.head),
        },
      ];
    }
  }
  if (
    insertedText === " " &&
    typed.empty &&
    transaction.startState.sliceDoc(typed.head, typed.head + 1) === " "
  ) {
    let chipFollows = false;
    chips.between(typed.head + 1, typed.head + 1, (chipFrom) => {
      chipFollows ||= chipFrom === typed.head + 1;
    });
    if (chipFollows) {
      return { selection: EditorSelection.cursor(typed.head + 1), scrollIntoView: true };
    }
  }
  const separators: { from: number; caret?: number }[] = [];
  // Preserve the protocol boundary for every surviving chip, including IME
  // composition and deletion of its adjacent whitespace. A required separator
  // cannot be removed while that would merge the recipient into another word.
  chips.between(0, transaction.startState.doc.length, (chipFrom, chipTo) => {
    const from = transaction.changes.mapPos(chipFrom, 1, MapMode.TrackAfter);
    const to = transaction.changes.mapPos(chipTo, -1, MapMode.TrackBefore);
    if (from === null || to === null || to - from !== chipTo - chipFrom) {
      return;
    }
    if (MENTION_BEFORE.test(transaction.newDoc.sliceString(Math.max(0, from - 2), from))) {
      separators.push({
        from,
        ...(transaction.isUserEvent("input") && transaction.state.selection.main.head === from
          ? { caret: from }
          : {}),
      });
    }
    if (
      MENTION_AFTER.test(
        transaction.newDoc.sliceString(to, Math.min(transaction.newDoc.length, to + 2)),
      )
    ) {
      separators.push({ from: to });
    }
  });
  if (!separators.length) {
    return transaction;
  }
  const changes = separators.map(({ from }) => ({ from, insert: " " }));
  const caret = separators.find((separator) => separator.caret !== undefined)?.caret;
  const mapped = transaction.state.changes(changes);
  return [
    transaction,
    {
      changes,
      sequential: true,
      selection: EditorSelection.cursor(
        caret ?? mapped.mapPos(transaction.state.selection.main.head, 1),
      ),
    },
  ];
});

export const setMentionDecorations = StateEffect.define<DecorationSet>();
// Word/line selection (double/triple click) is not atomic-aware; never let any
// selection end inside a chip, so typing can't rewrite part of a recipient.
export const keepSelectionOutsideMentions = EditorState.transactionFilter.of((transaction) => {
  if (!transaction.selection) {
    return transaction;
  }
  const chips = transaction.state.field(mentionDecorations, false);
  if (!chips || chips.size === 0) {
    return transaction;
  }
  let changed = false;
  const ranges = transaction.selection.ranges.map((range) => {
    let { anchor, head } = range;
    const outside = (position: number, towardEnd: boolean) => {
      let next = position;
      chips.between(position, position, (from, to) => {
        if (from < position && position < to) {
          next = towardEnd ? to : from;
        }
      });
      return next;
    };
    if (range.empty) {
      chips.between(head, head, (from, to) => {
        if (from < head && head < to) {
          head = anchor = head - from < to - head ? from : to;
        }
      });
    } else {
      const forward = head >= anchor;
      anchor = outside(anchor, !forward);
      head = outside(head, forward);
    }
    changed ||= anchor !== range.anchor || head !== range.head;
    return EditorSelection.range(anchor, head);
  });
  return changed
    ? [
        transaction,
        {
          selection: EditorSelection.create(ranges, transaction.selection.mainIndex),
          sequential: true,
        },
      ]
    : transaction;
});
/** History carries complete recipient identity, including same-text selection changes. */
export const restoreMentions = StateEffect.define<readonly HumanMention[]>({
  map: (mentions, mapping) =>
    mentions.flatMap((mention) => {
      const start = mapping.mapPos(mention.start, 1);
      const end = mapping.mapPos(mention.end, -1);
      return end > start ? [{ ...mention, start, end }] : [];
    }),
});
export const rememberMentionHistory = invertedEffects.of((transaction) => {
  const chips = transaction.startState.field(mentionDecorations, false);
  if (
    !chips ||
    (!transaction.docChanged && !transaction.effects.some((effect) => effect.is(restoreMentions)))
  ) {
    return [];
  }
  const previous: HumanMention[] = [];
  let removed = false;
  chips.between(0, transaction.startState.doc.length, (start, end, value) => {
    const widget = value.spec.widget;
    if (widget instanceof MentionChip) {
      previous.push({ profileId: widget.profileId, start, end });
      removed ||=
        transaction.changes.mapPos(start, 1, MapMode.TrackAfter) === null ||
        transaction.changes.mapPos(end, -1, MapMode.TrackBefore) === null;
    }
  });
  // Plain text and cancellable composition padding need no identity history.
  return removed || transaction.effects.some((effect) => effect.is(restoreMentions))
    ? [restoreMentions.of(previous)]
    : [];
});
/** Mapped through every change so atomic boundaries never lag the document. */
export const mentionDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setMentionDecorations)) {
        return effect.value;
      }
    }
    return value.map(transaction.changes);
  },
  provide: (field) => [
    EditorView.decorations.from(field),
    // The caret, selection and deletion treat each mention as one character.
    EditorView.atomicRanges.of((view) => view.state.field(field)),
  ],
});
