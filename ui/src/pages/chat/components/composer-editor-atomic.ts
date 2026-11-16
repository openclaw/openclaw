import { isolateHistory } from "@codemirror/commands";
import { EditorSelection, EditorState, MapMode, Prec, Transaction } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";

/** Shared atomic editing from person mentions. Features own their ranges and
 * token grammar; this extension owns caret, boundary and IME behavior. */
export function composerAtomicEditing(
  readRanges: (state: EditorState) => DecorationSet,
  before: RegExp | undefined,
  after: RegExp,
  canEdit: () => boolean,
) {
  // Typing straight against an atomic chip inserts the protocol's boundary
  // separator instead of silently dissolving the chip.
  const separateTypedText = EditorState.transactionFilter.of((transaction) => {
    if (
      !transaction.docChanged ||
      (!transaction.isUserEvent("input") && !transaction.isUserEvent("delete")) ||
      transaction.isUserEvent("input.type.compose") ||
      // Owner synchronization must mirror the raw draft exactly.
      transaction.isUserEvent("input.complete")
    ) {
      return transaction;
    }
    const chips = readRanges(transaction.startState);
    if (!chips || chips.size === 0) {
      return transaction;
    }
    // Typing the separator we inserted steps over it instead of doubling it.
    const typed = transaction.startState.selection.main;
    let insertedText: string | undefined = "";
    transaction.changes.iterChanges((_fromA, _toA, _fromB, _toB, text) => {
      // Only single-character separator edits need their text. Do not serialize
      // a large paste merely to compare it with an apostrophe or a space.
      insertedText =
        insertedText !== undefined && insertedText.length + text.length <= 1
          ? insertedText + text.toString()
          : undefined;
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
    let visitedFrom = -1;
    transaction.changes.iterChangedRanges((changedFrom, changedTo) => {
      chips.between(
        Math.max(0, changedFrom - 2),
        Math.min(transaction.startState.doc.length, changedTo + 2),
        (chipFrom, chipTo) => {
          // Ordered change windows can overlap the same chip. Inspect it only once.
          if (chipFrom <= visitedFrom) {
            return;
          }
          visitedFrom = chipFrom;
          const from = transaction.changes.mapPos(chipFrom, 1, MapMode.TrackAfter);
          const to = transaction.changes.mapPos(chipTo, -1, MapMode.TrackBefore);
          if (from === null || to === null || to - from !== chipTo - chipFrom) {
            return;
          }
          if (before?.test(transaction.newDoc.sliceString(Math.max(0, from - 2), from))) {
            separators.push({
              from,
              ...(transaction.isUserEvent("input") && transaction.state.selection.main.head === from
                ? { caret: from }
                : {}),
            });
          }
          if (
            after.test(
              transaction.newDoc.sliceString(to, Math.min(transaction.newDoc.length, to + 2)),
            )
          ) {
            separators.push({ from: to });
          }
        },
      );
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

  // Word/line selection (double/triple click) is not atomic-aware; never let any
  // selection end inside a chip, so typing can't rewrite part of a recipient.
  const keepSelectionOutsideAtoms = EditorState.transactionFilter.of((transaction) => {
    if (!transaction.selection) {
      return transaction;
    }
    const chips = readRanges(transaction.state);
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
  let compositionPadding: { value: string; removals: { from: number; to: number }[] } | undefined;
  function prepareComposition(view: EditorView) {
    compositionPadding = undefined;
    const selection = view.state.selection.main;
    let padLeft = false;
    let padRight = false;
    readRanges(view.state).between(selection.from, selection.to, (from, to) => {
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

  return [
    separateTypedText,
    keepSelectionOutsideAtoms,
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
  ];
}
