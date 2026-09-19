import {
  cursorGroupLeft,
  cursorGroupRight,
  cursorLineUp,
  cursorLineDown,
  deleteGroupBackward,
  deleteGroupForward,
  cursorLineBoundaryBackward,
  cursorLineBoundaryForward,
  cursorLineBoundaryLeft,
  cursorLineBoundaryRight,
  cursorPageUp,
  cursorPageDown,
  deleteCharBackward,
  deleteCharBackwardStrict,
  historyKeymap,
  undo,
  redo,
  insertNewline,
  insertNewlineAndIndent,
  standardKeymap,
  transposeChars,
} from "@codemirror/commands";
import { EditorSelection, type SelectionRange } from "@codemirror/state";
import { Direction, EditorView, keymap, type Command } from "@codemirror/view";
import { chipDecorations } from "./composer-editor-chips.ts";
import { composerWordBoundary } from "./composer-editor-words.ts";

function moveSelection(view: EditorView, target: SelectionRange, extend: boolean) {
  const selection = extend
    ? EditorSelection.range(
        view.state.selection.main.anchor,
        target.head,
        target.goalColumn,
        target.bidiLevel ?? undefined,
        target.assoc,
      )
    : target;
  view.dispatch({
    selection: EditorSelection.create([selection]),
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
}

function lineBoundary(view: EditorView, forward: boolean, extend: boolean) {
  return moveSelection(view, view.moveToLineBoundary(view.state.selection.main, forward), extend);
}

function pageBoundary(view: EditorView, host: HTMLElement, forward: boolean, extend: boolean) {
  const range = view.state.selection.main;
  // Refresh layout before reading the cached line height after a font or size change.
  view.coordsAtPos(range.head);
  const distance = Math.max(view.defaultLineHeight, host.clientHeight - view.defaultLineHeight);
  const target = view.moveVertically(range, forward, distance);
  return moveSelection(view, target, extend);
}

function vertical(view: EditorView, forward: boolean, extend: boolean) {
  const range = view.state.selection.main;
  const moved = view.moveVertically(range, forward);
  return moveSelection(
    view,
    moved.head === range.head ? view.moveToLineBoundary(range, forward) : moved,
    extend,
  );
}

function wordTarget(view: EditorView, forward: boolean) {
  let target = composerWordBoundary(view.state.doc, view.state.selection.main.head, forward);
  view.state.field(chipDecorations).between(target, target, (from, to) => {
    if (from < target && target < to) {
      target = forward ? to : from;
    }
  });
  return target;
}

function wordMovement(view: EditorView, right: boolean, extend: boolean) {
  const forward =
    right === (view.textDirectionAt(view.state.selection.main.head) === Direction.LTR);
  return moveSelection(view, EditorSelection.cursor(wordTarget(view, forward)), extend);
}

function wordDeletion(view: EditorView, forward: boolean) {
  if (view.state.readOnly) {
    return false;
  }
  const range = view.state.selection.main;
  const target = range.empty ? wordTarget(view, forward) : range.head;
  const from = range.empty ? Math.min(range.head, target) : range.from;
  const to = range.empty ? Math.max(range.head, target) : range.to;
  if (from === to) {
    return true;
  }
  view.dispatch({
    changes: { from, to },
    selection: { anchor: from },
    scrollIntoView: true,
    userEvent: forward ? "delete.word.forward" : "delete.word.backward",
  });
  return true;
}

const replacedCommands = new Set<Command>([
  cursorGroupLeft,
  cursorGroupRight,
  cursorLineUp,
  cursorLineDown,
  deleteGroupBackward,
  deleteGroupForward,
  cursorLineBoundaryBackward,
  cursorLineBoundaryForward,
  cursorLineBoundaryLeft,
  cursorLineBoundaryRight,
  cursorPageUp,
  cursorPageDown,
  deleteCharBackward,
  insertNewlineAndIndent,
  transposeChars,
]);

/** Textbox editing and host-sized navigation replace CodeMirror's code-editor policies. */
export function composerKeymap(host: HTMLElement) {
  return keymap.of([
    {
      mac: "Ctrl-t",
      run: (view) => {
        const selection = view.state.selection.main;
        let adjacentChip = false;
        if (selection.empty) {
          view.state.field(chipDecorations).between(selection.head, selection.head, (from, to) => {
            if (from === selection.head || to === selection.head) {
              adjacentChip = true;
            }
          });
        }
        return adjacentChip || transposeChars(view);
      },
    },
    {
      key: "Enter",
      run: (view) => !view.state.readOnly && insertNewline(view),
      shift: (view) => !view.state.readOnly && insertNewline(view),
    },
    {
      key: "Home",
      run: (view) => lineBoundary(view, false, false),
      shift: (view) => lineBoundary(view, false, true),
      preventDefault: true,
    },
    {
      key: "End",
      run: (view) => lineBoundary(view, true, false),
      shift: (view) => lineBoundary(view, true, true),
      preventDefault: true,
    },
    {
      mac: "Cmd-ArrowLeft",
      run: (view) =>
        lineBoundary(
          view,
          view.textDirectionAt(view.state.selection.main.head) !== Direction.LTR,
          false,
        ),
      shift: (view) =>
        lineBoundary(
          view,
          view.textDirectionAt(view.state.selection.main.head) !== Direction.LTR,
          true,
        ),
      preventDefault: true,
    },
    {
      mac: "Cmd-ArrowRight",
      run: (view) =>
        lineBoundary(
          view,
          view.textDirectionAt(view.state.selection.main.head) === Direction.LTR,
          false,
        ),
      shift: (view) =>
        lineBoundary(
          view,
          view.textDirectionAt(view.state.selection.main.head) === Direction.LTR,
          true,
        ),
      preventDefault: true,
    },
    {
      key: "PageUp",
      run: (view) => pageBoundary(view, host, false, false),
      shift: (view) => pageBoundary(view, host, false, true),
      preventDefault: true,
    },
    {
      key: "PageDown",
      run: (view) => pageBoundary(view, host, true, false),
      shift: (view) => pageBoundary(view, host, true, true),
      preventDefault: true,
    },
    {
      mac: "Ctrl-ArrowUp",
      run: (view) => pageBoundary(view, host, false, false),
      shift: (view) => pageBoundary(view, host, false, true),
      preventDefault: true,
    },
    {
      mac: "Ctrl-ArrowDown",
      run: (view) => pageBoundary(view, host, true, false),
      shift: (view) => pageBoundary(view, host, true, true),
      preventDefault: true,
    },
    {
      key: "Backspace",
      run: deleteCharBackwardStrict,
      shift: deleteCharBackwardStrict,
      preventDefault: true,
    },
    { mac: "Ctrl-h", run: deleteCharBackwardStrict },
    {
      key: "ArrowUp",
      run: (view) => vertical(view, false, false),
      shift: (view) => vertical(view, false, true),
      preventDefault: true,
    },
    {
      key: "ArrowDown",
      run: (view) => vertical(view, true, false),
      shift: (view) => vertical(view, true, true),
      preventDefault: true,
    },
    {
      mac: "Ctrl-p",
      run: (view) => vertical(view, false, false),
      shift: (view) => vertical(view, false, true),
      preventDefault: true,
    },
    {
      mac: "Ctrl-n",
      run: (view) => vertical(view, true, false),
      shift: (view) => vertical(view, true, true),
      preventDefault: true,
    },
    {
      mac: "Ctrl-v",
      run: (view) => pageBoundary(view, host, true, false),
      shift: (view) => pageBoundary(view, host, true, true),
      preventDefault: true,
    },
    {
      key: "Mod-ArrowLeft",
      mac: "Alt-ArrowLeft",
      run: (view) => wordMovement(view, false, false),
      shift: (view) => wordMovement(view, false, true),
      preventDefault: true,
    },
    {
      key: "Mod-ArrowRight",
      mac: "Alt-ArrowRight",
      run: (view) => wordMovement(view, true, false),
      shift: (view) => wordMovement(view, true, true),
      preventDefault: true,
    },
    {
      key: "Mod-Backspace",
      mac: "Alt-Backspace",
      run: (view) => wordDeletion(view, false),
      preventDefault: true,
    },
    {
      key: "Mod-Delete",
      mac: "Alt-Delete",
      run: (view) => wordDeletion(view, true),
      preventDefault: true,
    },
    { mac: "Ctrl-Alt-h", run: (view) => wordDeletion(view, false), preventDefault: true },
    ...standardKeymap.filter((binding) => !binding.run || !replacedCommands.has(binding.run)),
    ...historyKeymap.filter((binding) => binding.run === undo || binding.run === redo),
  ]);
}
