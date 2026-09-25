import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";
import { loadCodeLanguage } from "../../../components/code-language.ts";
import { detectLineSeparator } from "./file-line-separator.ts";

export type FileEditorDecorations = {
  targetLine?: number | null;
  matches?: readonly number[];
  currentMatch?: number | null;
};

export type FileEditorViewHandle = {
  destroy: () => void;
  setContent: (content: string) => void;
  contentEquals: (content: string) => boolean;
  setEditable: (editable: boolean) => void;
  setLineWrapping: (wrap: boolean) => void;
  setDecorations: (decorations: FileEditorDecorations) => void;
  scrollToLine: (line: number, center: boolean) => void;
  getContent: () => string;
  onDocChanged: (callback: (content: string) => void) => void;
  focus: () => void;
};

const setLineDecorations = StateEffect.define<DecorationSet>();
const lineDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (value, transaction) => {
    for (const effect of transaction.effects) {
      if (effect.is(setLineDecorations)) {
        return effect.value;
      }
    }
    return value.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

export async function createFileEditorView(params: {
  parent: HTMLElement;
  content: string;
  name: string;
  editable?: boolean;
  wrap?: boolean;
  onSave: () => void;
}): Promise<FileEditorViewHandle> {
  const editable = new Compartment();
  const wrapping = new Compartment();
  const language = await loadCodeLanguage(params.name);
  let docChanged: ((content: string) => void) | null = null;
  let destroyed = false;
  let isEditable = params.editable === true;
  let isWrapped = params.wrap === true;
  let separator = detectLineSeparator(params.content);
  let sourceContent = params.content;
  const readContent = (state: EditorState) =>
    state.doc.eq(sourceDocument)
      ? sourceContent
      : state.doc.sliceString(0, state.doc.length, separator ?? "\n");

  const buildState = (content: string) =>
    EditorState.create({
      doc: content,
      extensions: [
        // Keep default newline parsing for typing and paste. The file's
        // separator belongs to serialization, not incoming text interpretation.
        lineNumbers(),
        highlightSpecialChars(),
        history(),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              params.onSave();
              return true;
            },
          },
        ]),
        syntaxHighlighting(classHighlighter),
        ...(language ? [language] : []),
        EditorView.contentAttributes.of({ "aria-label": params.name, tabindex: "0" }),
        editable.of([EditorState.readOnly.of(!isEditable), EditorView.editable.of(isEditable)]),
        wrapping.of(isWrapped ? EditorView.lineWrapping : []),
        lineDecorations,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            docChanged?.(readContent(update.state));
          }
        }),
      ],
    });

  const initialState = buildState(params.content);
  let sourceDocument = initialState.doc;
  params.parent.replaceChildren();
  const view = new EditorView({
    parent: params.parent,
    // The app shell is slotted through the tooltip provider's shadow root, so
    // CodeMirror's default root detection lands there and mounts its base
    // theme where slotted light-DOM content can't see it. The panel lives in
    // the document's light DOM, so the document is the correct style root.
    root: document,
    state: initialState,
  });

  const clampLine = (line: number) => Math.max(1, Math.min(Math.floor(line), view.state.doc.lines));
  // Compare logical lines without treating a read-only mixed-ending preview as an edit.
  const contentEquals = (content: string) => view.state.toText(content).eq(view.state.doc);

  return {
    destroy: () => {
      if (!destroyed) {
        destroyed = true;
        view.destroy();
      }
    },
    setContent: (content) => {
      if (destroyed) {
        return;
      }
      const nextSeparator = detectLineSeparator(content);
      sourceContent = content;
      sourceDocument = view.state.toText(content);
      if (nextSeparator !== separator) {
        separator = nextSeparator;
        view.setState(buildState(content));
        return;
      }
      if (view.state.doc.eq(sourceDocument)) {
        return;
      }
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
    },
    contentEquals,
    setEditable: (nextEditable) => {
      if (destroyed) {
        return;
      }
      // Tracked so a setContent state rebuild keeps the current edit mode.
      isEditable = nextEditable;
      view.dispatch({
        effects: editable.reconfigure([
          EditorState.readOnly.of(!nextEditable),
          EditorView.editable.of(nextEditable),
        ]),
      });
    },
    setLineWrapping: (wrap) => {
      if (destroyed || wrap === isWrapped) {
        return;
      }
      // Tracked so a setContent state rebuild keeps the current wrap mode.
      isWrapped = wrap;
      view.dispatch({ effects: wrapping.reconfigure(wrap ? EditorView.lineWrapping : []) });
    },
    setDecorations: ({ targetLine, matches = [], currentMatch }) => {
      if (destroyed) {
        return;
      }
      const matchingLines = new Set(matches);
      const lineNumbersToDecorate = new Set(matches);
      if (targetLine != null) {
        lineNumbersToDecorate.add(targetLine);
      }
      if (currentMatch != null) {
        lineNumbersToDecorate.add(currentMatch);
      }
      const decorations = [...lineNumbersToDecorate]
        .filter((line) => Number.isInteger(line) && line >= 1 && line <= view.state.doc.lines)
        .toSorted((a, b) => a - b)
        .map((line) => {
          const classes: string[] = [];
          if (line === targetLine) {
            classes.push("file-view__line--target");
          }
          if (matchingLines.has(line)) {
            classes.push("file-view__line--match");
          }
          if (line === currentMatch) {
            classes.push("file-view__line--current");
          }
          return Decoration.line({
            class: classes.join(" "),
            ...(line === targetLine ? { attributes: { "data-line": String(line) } } : {}),
          }).range(view.state.doc.line(line).from);
        });
      view.dispatch({ effects: setLineDecorations.of(Decoration.set(decorations)) });
    },
    scrollToLine: (line, center) => {
      if (destroyed) {
        return;
      }
      view.dispatch({
        effects: EditorView.scrollIntoView(view.state.doc.line(clampLine(line)).from, {
          y: center ? "center" : "nearest",
        }),
      });
    },
    // Preserve exact source bytes before edits and after undo; changed text
    // adopts the loaded file's separator, including pasted multiline input.
    getContent: () => readContent(view.state),
    onDocChanged: (callback) => {
      docChanged = callback;
    },
    focus: () => view.focus(),
  };
}
