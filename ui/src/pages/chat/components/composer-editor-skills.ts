import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import { createIconElement } from "../../../components/markdown-icon.ts";
import { SLASH_COMMANDS } from "../../../lib/chat/commands.ts";
import {
  readComposerSkillReferences,
  subscribeSlashCommands,
  type ComposerSkillReference,
} from "../../../lib/chat/skill-references.ts";
import { composerAtomicEditing } from "./composer-editor-atomic.ts";

class SkillChip extends WidgetType {
  constructor(
    readonly name: string,
    readonly label: string,
  ) {
    super();
  }
  override eq(other: SkillChip) {
    return this.name === other.name && this.label === other.label;
  }
  toDOM() {
    const node = document.createElement("span");
    node.className = "chat-composer-skill";
    node.dataset.skillName = this.name;
    node.append(createIconElement("pencilSparkles", node.ownerDocument), this.label);
    return node;
  }
  override ignoreEvent() {
    return false;
  }
}

const noSkillDecorations = {
  ranges: Decoration.none,
  editing: undefined,
  hasDollar: false,
  plain: true,
  images: false,
  firstContent: -1,
  maxCommandNameLength: 0,
};

function decorations(value: string, editingAt?: number, maxCommandNameLength?: number) {
  if (!value.includes("$")) {
    return noSkillDecorations;
  }
  let editing: ComposerSkillReference | undefined;
  const ranges = Decoration.set(
    readComposerSkillReferences(value).flatMap((reference) => {
      const { start, end, name, label } = reference;
      if (editingAt !== undefined && start < editingAt && editingAt <= end) {
        editing = reference;
        return [];
      }
      return [Decoration.replace({ widget: new SkillChip(name, label) }).range(start, end)];
    }),
  );
  return {
    ranges,
    editing,
    hasDollar: true,
    plain: !/[`~\t]| {4}/u.test(value),
    images: value.includes("!["),
    firstContent: value.search(/\S/u),
    maxCommandNameLength:
      maxCommandNameLength ??
      SLASH_COMMANDS.reduce((max, command) => Math.max(max, command.name.length), 0),
  };
}

const skillCatalogChanged = StateEffect.define<number | undefined>();

const skillDecorations = StateField.define<ReturnType<typeof decorations>>({
  create: (state) => decorations(state.doc.toString()),
  update(value, transaction) {
    const refreshed = transaction.effects.find((effect) => effect.is(skillCatalogChanged));
    if (refreshed) {
      if (!value.hasDollar && !transaction.docChanged) {
        return value;
      }
      return decorations(transaction.newDoc.toString(), refreshed.value ?? value.editing?.end);
    }
    if (!transaction.docChanged) {
      const editing = value.editing;
      const head = transaction.newSelection.main.head;
      if (editing && transaction.selection && (head <= editing.start || head > editing.end)) {
        // Promote only the completed token left by the caret; no document scan or
        // follow-up transaction is needed for selection and owner echoes.
        return {
          ...value,
          editing: undefined,
          ranges: value.ranges.update({
            add: [
              Decoration.replace({ widget: new SkillChip(editing.name, editing.label) }).range(
                editing.start,
                editing.end,
              ),
            ],
            sort: true,
          }),
        };
      }
      return value;
    }
    let hasDollar = value.hasDollar;
    if (!hasDollar) {
      transaction.changes.iterChanges((_from, _to, _newFrom, _newTo, inserted) => {
        hasDollar ||= inserted.toString().includes("$");
      });
      // Mention-only editing keeps its existing document-read budget.
      if (!hasDollar) {
        return value;
      }
    }
    // Map ordinary edits. Token and Markdown-structure changes still use the
    // canonical parser, including combined changes in the resulting document.
    // Image reference labels can change code interpretation at a distance, so
    // image-bearing drafts deliberately retain the full parse.
    let reparse = value.images || value.editing !== undefined;
    transaction.changes.iterChanges((from, to, newFrom, newTo, inserted) => {
      if (reparse) {
        return;
      }
      const doc = transaction.startState.doc;
      const removed = doc.sliceString(from, to);
      const added = inserted.toString();
      const line = !value.plain ? doc.lineAt(from) : undefined;
      reparse =
        from <= value.firstContent ||
        /[$`~\t\\[\]!|]/u.test(removed + added) ||
        (line !== undefined &&
          (from <= line.from + 4 ||
            /^[ \t]/u.test(line.text) ||
            /^ {0,3}(?:[\d>#*+_=:-]|`{3,}|~{3,})/u.test(line.text) ||
            /[\r\n]/u.test(removed + added))) ||
        /[$`~\\[\]!|]/u.test(
          doc.sliceString(Math.max(0, from - 1), from) + doc.sliceString(to, to + 1),
        ) ||
        / {4}/u.test(transaction.newDoc.sliceString(Math.max(0, newFrom - 3), newTo + 3));
      if (!reparse) {
        const start = Math.max(0, from - value.maxCommandNameLength - 2);
        const prefix = doc.sliceString(start, from);
        const boundary = /[^-a-zA-Z0-9_:][-a-zA-Z0-9_:]*$/u.exec(prefix);
        // A name reaching beyond the window can only resolve if its excess is
        // all trailing colons, which the canonical parser strips.
        reparse = boundary
          ? boundary[0].startsWith("$")
          : start > 0 && !/[^:]/u.test(prefix.slice(value.maxCommandNameLength));
      }
    });
    if (!reparse) {
      return { ...value, ranges: value.ranges.map(transaction.changes) };
    }
    const text = transaction.newDoc.toString();
    return decorations(
      text,
      transaction.isUserEvent("input.type") ? transaction.state.selection.main.head : undefined,
      value.hasDollar ? value.maxCommandNameLength : undefined,
    );
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.ranges),
    EditorView.atomicRanges.of((view) => view.state.field(field).ranges),
  ],
});

const skillTheme = EditorView.theme({
  ".chat-composer-skill > svg": {
    display: "inline-block",
    width: "1em",
    height: "1em",
    marginInlineEnd: "0.22em",
    verticalAlign: "calc((1cap - 1em) / 2)",
    pointerEvents: "none",
    userSelect: "none",
    WebkitUserSelect: "none",
  },
  ".chat-composer-skill": {
    display: "inline-block",
    boxSizing: "border-box",
    maxWidth: "100%",
    lineHeight: "normal",
    borderRadius: "var(--radius-sm)",
    padding: "0 0.2em",
    background: "var(--person-reference-bg)",
    color: "var(--chat-text-link, var(--link))",
    fontWeight: "550",
    overflowWrap: "anywhere",
    cursor: "default",
    userSelect: "text",
    WebkitUserSelect: "text",
  },
});

export function composerSkillExtension(input: HTMLTextAreaElement) {
  return [
    skillDecorations,
    ViewPlugin.define((view) => ({
      // Catalog replacement is an explicit invalidation, not per-key polling.
      destroy: subscribeSlashCommands(() => {
        view.dispatch({
          effects: skillCatalogChanged.of(
            view.composing ? view.state.selection.main.head : undefined,
          ),
        });
      }),
    })),
    composerAtomicEditing(
      (state) => state.field(skillDecorations, false)?.ranges ?? Decoration.none,
      // The skill protocol permits text immediately before $, but not inside its name.
      undefined,
      /^[-a-zA-Z0-9_:]/u,
      () => !input.disabled && !input.readOnly,
    ),
    skillTheme,
  ];
}
