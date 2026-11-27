import { invertedEffects, isolateHistory } from "@codemirror/commands";
import { MapMode, StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import {
  registerFileReferenceDestination,
  type FileReferenceDestination,
  type FileReferenceDestinationReceipt,
} from "../../../lib/chat/file-reference-destination.ts";
import {
  readComposerFileReferences,
  withComposerFileReferenceEdit,
  type ComposerFileReference,
} from "../../../lib/chat/file-references.ts";
import {
  mountComposerEditor,
  type ComposerEditorOptions,
  type ComposerEditorSnapshot,
} from "./composer-editor-view.tsx";

class FileReferenceChip extends WidgetType {
  constructor(
    readonly text: string,
    readonly root: string,
    readonly path: string,
  ) {
    super();
  }
  override eq(other: FileReferenceChip) {
    return this.text === other.text && this.root === other.root && this.path === other.path;
  }
  toDOM(view: EditorView) {
    const span = view.dom.ownerDocument.createElement("span");
    span.className = "chat-composer-file-reference";
    span.textContent = this.text;
    span.dir = "auto";
    span.title = `${this.root}: ${this.path}`;
    return span;
  }
}

const restoreFileReferences = StateEffect.define<readonly ComposerFileReference[]>();
function referenceState(
  references: readonly ComposerFileReference[],
  text: string,
  revision: number,
) {
  return {
    references,
    revision,
    decorations: Decoration.set(
      references.map(({ start, end, reference }) =>
        Decoration.replace({
          widget: new FileReferenceChip(
            text.slice(start, end),
            reference.rootLabel,
            reference.relativePath,
          ),
        }).range(start, end),
      ),
    ),
  };
}

const fileReferences = StateField.define<ReturnType<typeof referenceState>>({
  create: (state) => referenceState([], state.doc.toString(), 0),
  update(value, transaction) {
    const restored = transaction.effects.findLast((effect) => effect.is(restoreFileReferences));
    if (!transaction.docChanged && !restored) {
      return value;
    }
    const references = restored
      ? restored.value
      : value.references.flatMap((item) => {
          let touched = false;
          transaction.changes.iterChangedRanges((from, to) => {
            touched ||=
              from === to
                ? from > item.start && from < item.end
                : from < item.end && to > item.start;
          });
          if (touched) {
            return [];
          }
          const start = transaction.changes.mapPos(item.start, 1, MapMode.TrackAfter);
          const end = transaction.changes.mapPos(item.end, -1, MapMode.TrackBefore);
          return start === null || end === null ? [] : [{ ...item, start, end }];
        });
    return referenceState(
      readComposerFileReferences(transaction.newDoc.toString(), references) ?? [],
      transaction.newDoc.toString(),
      value.revision + 1,
    );
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).decorations),
  ],
});

function readReferences(state: EditorState) {
  return state.field(fileReferences).references;
}

/** The existing editor owns both text and objects, including one undo transaction. */
export function mountFileReferenceComposerEditor(
  input: HTMLTextAreaElement,
  references: () => readonly ComposerFileReference[],
  options: ComposerEditorOptions,
  initialHistory?: ComposerEditorSnapshot,
) {
  const targetId = crypto.randomUUID();
  let disposed = false;
  const receipts = new Map<string, FileReferenceDestinationReceipt>();
  const editor = mountComposerEditor(
    input,
    {
      ...options,
      extensions: [
        options.extensions,
        fileReferences.init((state) =>
          referenceState(
            readComposerFileReferences(state.doc.toString(), references()) ?? [],
            state.doc.toString(),
            0,
          ),
        ),
        invertedEffects.of((transaction) => {
          const before = readReferences(transaction.startState);
          return (transaction.docChanged ||
            transaction.effects.some((effect) => effect.is(restoreFileReferences))) &&
            (before.length || readReferences(transaction.state).length)
            ? [restoreFileReferences.of(before)]
            : [];
        }),
      ],
      restoresAtomicRanges: (effect) =>
        effect.is(restoreFileReferences) || Boolean(options.restoresAtomicRanges?.(effect)),
      sync(view, previous) {
        const wanted = readComposerFileReferences(input.value, references()) ?? [];
        const effects = options.sync?.(view, previous) ?? [];
        return JSON.stringify(wanted) === JSON.stringify(readReferences(view.state))
          ? effects
          : [...effects, restoreFileReferences.of(wanted)];
      },
      onEdit(update, publish) {
        let published = false;
        const wrapped: Parameters<NonNullable<ComposerEditorOptions["onEdit"]>>[1] = (wrap) => {
          published = true;
          publish((edit, emit, next) =>
            withComposerFileReferenceEdit(next, readReferences(update.state), () =>
              wrap ? wrap(edit, emit, next) : emit(),
            ),
          );
        };
        options.onEdit?.(update, wrapped);
        if (
          !published &&
          (update.docChanged ||
            update.transactions.some((transaction) =>
              transaction.effects.some((effect) => effect.is(restoreFileReferences)),
            ))
        ) {
          wrapped();
        }
      },
    },
    initialHistory,
  );
  const destination: FileReferenceDestination = {
    schemaVersion: 1,
    namespace: "openclaw.session-file.v1",
    snapshot() {
      editor.sync();
      return {
        text: editor.view.state.doc.toString(),
        revision: editor.view.state.field(fileReferences).revision,
        targetId,
        references: readReferences(editor.view.state),
      };
    },
    commit(request) {
      const previous = receipts.get(request.id);
      if (previous) {
        return previous;
      }
      const reject = (): FileReferenceDestinationReceipt => {
        const receipt = { status: "not-committed" } as const;
        receipts.set(request.id, receipt);
        return receipt;
      };
      if (disposed || !input.isConnected || input.disabled || input.readOnly) {
        return reject();
      }
      const current = destination.snapshot();
      const inserted = readComposerFileReferences(request.text, request.references);
      if (
        request.snapshot.targetId !== targetId ||
        request.snapshot.revision !== current.revision ||
        request.snapshot.text !== current.text ||
        !Number.isSafeInteger(request.from) ||
        !Number.isSafeInteger(request.to) ||
        request.from < 0 ||
        request.to < request.from ||
        request.to > current.text.length ||
        !inserted ||
        current.references.some((item) => item.start < request.to && item.end > request.from)
      ) {
        return reject();
      }
      const delta = request.text.length - (request.to - request.from);
      const nextReferences = [
        ...current.references.map((item) =>
          item.start >= request.to
            ? { ...item, start: item.start + delta, end: item.end + delta }
            : item,
        ),
        ...inserted.map((item) => ({
          start: item.start + request.from,
          end: item.end + request.from,
          reference: item.reference,
        })),
      ].toSorted((left, right) => left.start - right.start);
      const text =
        current.text.slice(0, request.from) + request.text + current.text.slice(request.to);
      const canonicalReferences = readComposerFileReferences(text, nextReferences);
      if (!canonicalReferences) {
        return reject();
      }
      // Reentrant callbacks already see an uncertain receipt. No retry can insert again.
      const receipt: FileReferenceDestinationReceipt = { status: "outcome-unknown" };
      receipts.set(request.id, receipt);
      try {
        editor.view.dispatch({
          changes: { from: request.from, to: request.to, insert: request.text },
          effects: restoreFileReferences.of(canonicalReferences),
          annotations: isolateHistory.of("full"),
          selection: { anchor: request.from + request.text.length },
          userEvent: "input.file-reference",
        });
        if (
          editor.view.state.doc.toString() === text &&
          JSON.stringify(readReferences(editor.view.state)) === JSON.stringify(canonicalReferences)
        ) {
          receipt.status = "committed";
        }
      } catch {
        // The editor may have committed before an input listener threw. Keep the receipt uncertain.
      }
      return receipt;
    },
    clearReferences() {
      if (!disposed && !input.disabled && !input.readOnly) {
        editor.sync();
        editor.view.dispatch({
          effects: restoreFileReferences.of([]),
          annotations: isolateHistory.of("full"),
          userEvent: "input.file-reference-clear",
        });
      }
    },
  };
  const unregister = registerFileReferenceDestination(input, destination);
  return {
    ...editor,
    destroy: () => {
      disposed = true;
      unregister();
      editor.destroy();
    },
  };
}
