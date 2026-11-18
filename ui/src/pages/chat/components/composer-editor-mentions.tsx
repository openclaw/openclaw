import "../../../styles/chat/person-reference.css";
import { invertedEffects, isolateHistory } from "@codemirror/commands";
import {
  EditorSelection,
  EditorState,
  Facet,
  MapMode,
  Prec,
  Transaction,
  StateEffect,
  StateField,
  type ChangeDesc,
} from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { render } from "@solidjs/web";
import type { ApplicationContext } from "../../../app/context-types.ts";
import { PersonReferenceLabel } from "../../../components/solid/person-reference-label.tsx";
import type { HumanMention } from "../../../lib/chat/chat-types.ts";
import {
  MENTION_AFTER,
  MENTION_BEFORE,
  parseHumanMentionTransfer,
  prepareHumanMentionPaste,
  readHumanMentionClipboard,
  type HumanMentionTransfer,
} from "../../../lib/chat/human-mention-clipboard.ts";
import {
  HUMAN_MENTION_CLIPBOARD_TYPE,
  MAX_HUMAN_MENTIONS,
  readHumanMentions,
  withHumanMentionEdit,
} from "../../../lib/chat/human-mentions.ts";
import { ApplicationProvider } from "../../../lib/reactive/context.ts";
import {
  mountComposerEditor,
  type ComposerEditorOptions,
  type ComposerEditorSnapshot,
} from "./composer-editor-view.tsx";

// Style modules live for the document lifetime, not an individual editor mount.
const mentionTheme = EditorView.theme({
  // One box per chip: it moves to the next line whole, and only a name wider than
  // the line wraps inside it. A normal line height keeps the sent-reference shape.
  ".chat-composer-mention": {
    display: "inline-block",
    boxSizing: "border-box",
    maxWidth: "100%",
    lineHeight: "normal",
  },
  ".chat-composer-mention .markdown-person-reference__avatar": {
    userSelect: "text",
    WebkitUserSelect: "text",
  },
});

const chipDisposers = new WeakMap<HTMLElement, () => void>();
/** The whole selected mention renders as one atomic chip, exactly like a sent
 * reference. Its raw @Name text stays in the document for submission/clipboard. */
class MentionChip extends WidgetType {
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

// Typing straight against an atomic chip inserts the protocol's boundary
// separator instead of silently dissolving the chip.
const separateTypedTextFromMentions = EditorState.transactionFilter.of((transaction) => {
  if (
    !transaction.docChanged ||
    (!transaction.isUserEvent("input") && !transaction.isUserEvent("delete")) ||
    transaction.isUserEvent("input.type.compose") ||
    // Owner synchronization must mirror the raw draft exactly.
    transaction.isUserEvent("input.complete")
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
  // Backspace steps over the separator it may not remove, so the next press
  // deletes what precedes it instead of repeating a no-op.
  const side = transaction.isUserEvent("delete.backward") ? -1 : 1;
  return [
    transaction,
    {
      changes,
      sequential: true,
      selection: EditorSelection.cursor(
        caret ?? mapped.mapPos(transaction.state.selection.main.head, side),
      ),
    },
  ];
});

const mentionWidgetContext = Facet.define<{
  application?: ApplicationContext;
  avatarUrls?: ReadonlyMap<string, string>;
}>();

function createMentionDecorations(
  state: EditorState,
  mentions: readonly HumanMention[],
  value = state.doc.toString(),
): DecorationSet {
  const context = state.facet(mentionWidgetContext)[0];
  return Decoration.set(
    mentions.flatMap((mention) => {
      const label = value.slice(mention.start, mention.end);
      return label.startsWith("@") && mention.start + 1 < mention.end
        ? [
            Decoration.replace({
              widget: new MentionChip(
                mention.profileId,
                label,
                context?.application,
                context?.avatarUrls?.get(mention.profileId),
              ),
            }).range(mention.start, mention.end),
          ]
        : [];
    }),
    true,
  );
}

const setMentionDecorations = StateEffect.define<DecorationSet>();
// Word/line selection (double/triple click) is not atomic-aware; never let any
// selection end inside a chip, so typing can't rewrite part of a recipient.
const keepSelectionOutsideMentions = EditorState.transactionFilter.of((transaction) => {
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
const restoreMentions = StateEffect.define<readonly HumanMention[]>({
  map: (mentions, mapping) =>
    mentions.flatMap((mention) => {
      const start = mapping.mapPos(mention.start, 1);
      const end = mapping.mapPos(mention.end, -1);
      return end > start ? [{ ...mention, start, end }] : [];
    }),
});
function readEditorMentions(state: EditorState, changes?: ChangeDesc) {
  const mentions: HumanMention[] = [];
  const chips = state.field(mentionDecorations);
  const mapped = changes ? chips.map(changes) : chips;
  mapped.between(0, changes?.newLength ?? state.doc.length, (start, end, value) => {
    const widget = value.spec.widget;
    if (widget instanceof MentionChip) {
      mentions.push({ profileId: widget.profileId, start, end });
    }
  });
  return mentions;
}

const rememberMentionHistory = invertedEffects.of((transaction) => {
  const chips = transaction.startState.field(mentionDecorations, false);
  if (
    !chips ||
    (!transaction.docChanged && !transaction.effects.some((effect) => effect.is(restoreMentions)))
  ) {
    return [];
  }
  const previous = readEditorMentions(transaction.startState);
  const removed = previous.some(
    ({ start, end }) =>
      transaction.changes.mapPos(start, 1, MapMode.TrackAfter) === null ||
      transaction.changes.mapPos(end, -1, MapMode.TrackBefore) === null,
  );
  // Plain text and cancellable composition padding need no identity history.
  return removed || transaction.effects.some((effect) => effect.is(restoreMentions))
    ? [restoreMentions.of(previous)]
    : [];
});
/** Mapped through every change so atomic boundaries never lag the document. */
const mentionDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    // Restore identity in the same transaction as the document. Waiting for
    // the controller echo would make redo observe stale recipient ranges.
    const restored = transaction.effects.findLast((effect) => effect.is(restoreMentions));
    if (restored) {
      return createMentionDecorations(
        transaction.startState,
        restored.value,
        transaction.newDoc.toString(),
      );
    }
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

export type ComposerMentionSnapshot = ComposerEditorSnapshot & {
  mentions: readonly HumanMention[];
};

/** Whether the native snapshot is what this selection replaced: one @token, or
 * nothing. The owner clears a sent draft without an input event, so an older
 * snapshot may hold unrelated text that undo must never restore. Accepted edge:
 * a sent draft ending in a plain "@word" still passes. */
function precedesSelection(before: string, after: string) {
  let start = 0;
  while (start < before.length && before[start] === after[start]) {
    start += 1;
  }
  let end = before.length;
  for (
    let other = after.length;
    end > start && other > start && before[end - 1] === after[other - 1];
    other -= 1
  ) {
    end -= 1;
  }
  const token = before.lastIndexOf("@", start);
  return end === start || (token >= 0 && !before.slice(token, end).includes("\n"));
}

/** Person identity and its protocol rules are one feature of the shared editor. */
export function mountMentionComposerEditor(
  input: HTMLTextAreaElement,
  mentions: () => readonly HumanMention[],
  application?: ApplicationContext,
  nativeHistory?: ComposerMentionSnapshot,
  avatarUrls?: ReadonlyMap<string, string>,
) {
  const initialHistory =
    nativeHistory && precedesSelection(nativeHistory.value, input.value)
      ? nativeHistory
      : undefined;
  const canEdit = () => !input.disabled && !input.readOnly;
  let compositionPadding: { value: string; removals: { from: number; to: number }[] } | undefined;
  function prepareComposition(view: EditorView) {
    compositionPadding = undefined;
    const selection = view.state.selection.main;
    let padLeft = false;
    let padRight = false;
    view.state.field(mentionDecorations).between(selection.from, selection.to, (from, to) => {
      padLeft ||= to === selection.from;
      padRight ||= from === selection.to;
    });
    if (!padLeft && !padRight) {
      return;
    }
    const changes = [
      ...(padLeft ? [{ from: selection.from, insert: " " }] : []),
      ...(padRight ? [{ from: selection.to, insert: " " }] : []),
    ];
    const start = selection.from + Number(padLeft);
    const end = selection.to + Number(padLeft);
    // Reserve boundaries outside the selection BEFORE the IME owns its DOM
    // range. Candidate rewrites must not touch the composed range or join the
    // preceding edit's undo group (compose events always join in CM history).
    view.dispatch({
      changes,
      selection:
        selection.anchor <= selection.head
          ? EditorSelection.range(start, end)
          : EditorSelection.range(end, start),
      userEvent: "input.type.compose.start",
      annotations: isolateHistory.of("before"),
    });
    compositionPadding = {
      value: view.state.doc.toString(),
      removals: changes.map((change, index) => ({
        from: change.from + index,
        to: change.from + index + 1,
      })),
    };
  }
  function finishComposition(event: CompositionEvent, view: EditorView) {
    const padding = compositionPadding;
    compositionPadding = undefined;
    if (padding && !event.data && view.state.doc.toString() === padding.value) {
      view.dispatch({
        changes: padding.removals,
        userEvent: "delete.compose",
        annotations: Transaction.addToHistory.of(false),
      });
    }
  }

  let pendingTransfer: HumanMentionTransfer | undefined;
  function writeSelectedMentions(data: DataTransfer, view: EditorView) {
    const { from, to, empty } = view.state.selection.main;
    if (empty) {
      return false;
    }
    const copied = readEditorMentions(view.state)
      .filter((mention) => mention.start >= from && mention.end <= to)
      .map((mention) => ({
        profileId: mention.profileId,
        start: mention.start - from,
        end: mention.end - from,
      }));
    if (!copied.length) {
      return false;
    }
    data.setData("text/plain", view.state.sliceDoc(from, to));
    data.setData(HUMAN_MENTION_CLIPBOARD_TYPE, JSON.stringify(copied));
    return true;
  }
  function copySelection(event: ClipboardEvent, cut: boolean, view: EditorView) {
    if (!event.clipboardData || !writeSelectedMentions(event.clipboardData, view)) {
      return false;
    }
    const { from, to } = view.state.selection.main;
    event.preventDefault();
    if (cut && canEdit()) {
      view.dispatch({
        changes: { from, to },
        selection: EditorSelection.cursor(from),
        userEvent: "delete.cut",
        scrollIntoView: true,
      });
    }
    return true;
  }
  /** The one insertion path for recipient transfers the browser did not perform. */
  function insertTransfer(view: EditorView, copied: HumanMentionTransfer, userEvent: string) {
    const { from, to } = view.state.selection.main;
    pendingTransfer = prepareHumanMentionPaste(view.state.doc.toString(), from, to, copied);
    view.dispatch({ ...view.state.replaceSelection(pendingTransfer.text), userEvent });
  }
  function transferredMentions(transaction: Transaction): HumanMention[] | undefined {
    if (
      !transaction.isUserEvent("input.paste") &&
      !transaction.isUserEvent("input.drop") &&
      !transaction.isUserEvent("move.drop")
    ) {
      return undefined;
    }
    const paste = pendingTransfer;
    pendingTransfer = undefined;
    if (!paste) {
      return undefined;
    }
    const restored: HumanMention[] = [];
    transaction.changes.iterChanges((_fromA, _toA, fromB, _toB, inserted) => {
      const text = inserted.toString();
      // The atomic boundary filter may pad either side with one separator.
      const offset = text.startsWith(paste.text) ? 0 : text.startsWith(" " + paste.text) ? 1 : -1;
      if (offset < 0 || !["", " "].includes(text.slice(offset + paste.text.length))) {
        return;
      }
      restored.push(
        ...paste.mentions.map((mention) => ({
          profileId: mention.profileId,
          start: mention.start + fromB + offset,
          end: mention.end + fromB + offset,
        })),
      );
    });
    return restored;
  }

  const admittedMentions = readHumanMentions(input.value, mentions()) ?? [];
  const options: ComposerEditorOptions = {
    extensions: [
      mentionWidgetContext.of({ application, avatarUrls }),
      mentionDecorations.init((state) =>
        createMentionDecorations(state, initialHistory?.mentions ?? admittedMentions),
      ),
      separateTypedTextFromMentions,
      keepSelectionOutsideMentions,
      rememberMentionHistory,
      EditorState.transactionFilter.of((transaction) => {
        const copied = pendingTransfer;
        if (
          !copied ||
          (!transaction.isUserEvent("input.drop") && !transaction.isUserEvent("move.drop"))
        ) {
          return transaction;
        }
        const changes: { from: number; to: number; insert: string }[] = [];
        transaction.changes.iterChanges((_fromA, _toA, fromB, toB, inserted) => {
          if (inserted.toString() !== copied.text) {
            return;
          }
          // The native move has removed its source. Resolve boundaries against
          // that resulting document, including drops back onto the selection.
          pendingTransfer = prepareHumanMentionPaste(
            transaction.newDoc.toString(),
            fromB,
            toB,
            copied,
          );
          if (pendingTransfer.text !== copied.text) {
            changes.push({ from: fromB, to: toB, insert: pendingTransfer.text });
          }
        });
        return changes.length ? [transaction, { changes, sequential: true }] : transaction;
      }),
      EditorState.transactionExtender.of((transaction) => {
        const pasted = transferredMentions(transaction);
        if (!pasted) {
          return null;
        }
        const kept = readEditorMentions(transaction.startState, transaction.changes);
        // Over the protocol limit every recipient would fail validation; paste the
        // excess as plain text instead of discarding the existing bindings.
        const admitted = pasted.slice(0, Math.max(0, MAX_HUMAN_MENTIONS - kept.length));
        return {
          effects: restoreMentions.of(
            [...kept, ...admitted].toSorted((left, right) => left.start - right.start),
          ),
        };
      }),
      Prec.highest(
        EditorView.domEventHandlers({
          compositionstart(_event, view) {
            if (!canEdit()) {
              return true;
            }
            prepareComposition(view);
            return false;
          },
          compositionend(event, view) {
            finishComposition(event, view);
            return false;
          },
        }),
      ),
      // The host's higher-priority paste handler gives attachments first refusal.
      Prec.high(
        EditorView.domEventHandlers({
          copy(event, view) {
            return copySelection(event, false, view);
          },
          cut(event, view) {
            return copySelection(event, true, view);
          },
          dragstart(event, view) {
            if (event.dataTransfer) {
              writeSelectedMentions(event.dataTransfer, view);
            }
            return false;
          },
          drop(event) {
            pendingTransfer = readHumanMentionClipboard(event.dataTransfer);
            return false;
          },
          paste(event, view) {
            const copied = readHumanMentionClipboard(event.clipboardData);
            pendingTransfer = undefined;
            if (!copied) {
              return false;
            }
            event.preventDefault();
            insertTransfer(view, copied, "input.paste");
            return true;
          },
        }),
      ),
      mentionTheme,
    ],
    sync(view, previous) {
      const next = input.value;
      const nextMentions = readHumanMentions(next, mentions()) ?? [];
      const chips = view.state.field(mentionDecorations);
      if (next !== previous || chips.size !== nextMentions.length) {
        return [restoreMentions.of(nextMentions)];
      }
      // CM already maps chips through edits. Compare that state, not a stale
      // offset signature that rebuilds decorations after every owner echo.
      const cursor = chips.iter();
      let avatarsChanged = false;
      for (const mention of nextMentions) {
        const chip = cursor.value?.spec.widget;
        if (
          cursor.from !== mention.start ||
          cursor.to !== mention.end ||
          !(chip instanceof MentionChip) ||
          chip.profileId !== mention.profileId
        ) {
          return [restoreMentions.of(nextMentions)];
        }
        avatarsChanged ||= chip.avatarUrl !== avatarUrls?.get(mention.profileId);
        cursor.next();
      }
      return avatarsChanged
        ? [setMentionDecorations.of(createMentionDecorations(view.state, nextMentions, next))]
        : [];
    },
    onEdit(update, publish) {
      const historical = update.transactions
        .flatMap((transaction) => transaction.effects)
        .findLast((effect) => effect.is(restoreMentions));
      if (update.docChanged || historical) {
        // Grouped undo stores its earliest identity snapshot last.
        publish((edit, emit, next) => withHumanMentionEdit(next, historical?.value, edit, emit));
      }
    },
  };
  const editor = mountComposerEditor(input, options, initialHistory);
  return {
    sync: editor.sync,
    destroy: editor.destroy,
    /** Replays a paste or drop the native field received before this editor existed. */
    transfer(text: string, raw: string, drop: boolean) {
      if (!canEdit()) {
        return;
      }
      const userEvent = drop ? "input.drop" : "input.paste";
      const copied = parseHumanMentionTransfer(text, raw);
      if (copied) {
        insertTransfer(editor.view, copied, userEvent);
      } else {
        editor.view.dispatch({ ...editor.view.state.replaceSelection(text), userEvent });
      }
    },
  };
}
