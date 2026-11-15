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
  return { ranges, editing, hasDollar: value.includes("$") };
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
