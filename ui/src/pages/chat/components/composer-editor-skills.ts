import { StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { createIconElement } from "../../../components/markdown-icon.ts";
import {
  readComposerSkillReferences,
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

function decorations(value: string, editingAt?: number) {
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
    hasDollar: value.includes("$"),
    plain: !/[`~\t]| {4}/u.test(value),
    images: value.includes("!["),
    firstContent: value.search(/\S/u),
  };
}

const skillDecorations = StateField.define<ReturnType<typeof decorations>>({
  create: (state) => decorations(state.doc.toString()),
  update(value, transaction) {
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
      // Inspect only the contiguous token suffix, not the entire (possibly huge) line.
      for (let at = from; !reparse && at > 0; at--) {
        const char = doc.sliceString(at - 1, at);
        if (!/[-a-zA-Z0-9_:]/u.test(char)) {
          reparse = char === "$";
          break;
        }
      }
    });
    if (!reparse) {
      return { ...value, ranges: value.ranges.map(transaction.changes) };
    }
    const text = transaction.newDoc.toString();
    return decorations(
      text,
      transaction.isUserEvent("input.type") ? transaction.state.selection.main.head : undefined,
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
