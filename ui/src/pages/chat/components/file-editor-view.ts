import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
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

export type FileEditorDecorations = {
  targetLine?: number | null;
  matches?: readonly number[];
  currentMatch?: number | null;
};

export type FileEditorViewHandle = {
  destroy: () => void;
  setContent: (content: string) => void;
  setEditable: (editable: boolean) => void;
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

async function loadLanguage(name: string) {
  const description = LanguageDescription.matchFilename(languages, name);
  if (!description) {
    return null;
  }
  try {
    return await description.load();
  } catch {
    return null;
  }
}

export async function createFileEditorView(params: {
  parent: HTMLElement;
  content: string;
  name: string;
  editable?: boolean;
  onSave: () => void;
}): Promise<FileEditorViewHandle> {
  const editable = new Compartment();
  const language = await loadLanguage(params.name);
  let docChanged: ((content: string) => void) | null = null;
  let destroyed = false;

  params.parent.replaceChildren();
  const view = new EditorView({
    parent: params.parent,
    // The app shell is slotted through the tooltip provider's shadow root, so
    // CodeMirror's default root detection lands there and mounts its base
    // theme where slotted light-DOM content can't see it. The panel lives in
    // the document's light DOM, so the document is the correct style root.
    root: document,
    state: EditorState.create({
      doc: params.content,
      extensions: [
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
        editable.of([
          EditorState.readOnly.of(params.editable !== true),
          EditorView.editable.of(params.editable === true),
        ]),
        lineDecorations,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            docChanged?.(update.state.doc.toString());
          }
        }),
      ],
    }),
  });

  const clampLine = (line: number) => Math.max(1, Math.min(Math.floor(line), view.state.doc.lines));

  return {
    destroy: () => {
      if (!destroyed) {
        destroyed = true;
        view.destroy();
      }
    },
    setContent: (content) => {
      if (destroyed || content === view.state.doc.toString()) {
        return;
      }
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
    },
    setEditable: (isEditable) => {
      if (destroyed) {
        return;
      }
      view.dispatch({
        effects: editable.reconfigure([
          EditorState.readOnly.of(!isEditable),
          EditorView.editable.of(isEditable),
        ]),
      });
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
        .sort((a, b) => a - b)
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
    getContent: () => view.state.doc.toString(),
    onDocChanged: (callback) => {
      docChanged = callback;
    },
    focus: () => view.focus(),
  };
}
