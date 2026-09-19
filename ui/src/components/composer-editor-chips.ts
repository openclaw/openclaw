import {
  EditorSelection,
  type EditorState,
  Facet,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { render, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";

/** Ranges refer to the unchanged plain-text document, including the original token syntax. */
export type ComposerChip = {
  kind: "skill" | "mention";
  start: number;
  end: number;
  label: string;
  icon?: TemplateResult;
  avatarUrl?: string;
};

class ChipWidget extends WidgetType {
  constructor(readonly chip: ComposerChip) {
    super();
  }
  override eq(other: ChipWidget) {
    return (
      this.chip.kind === other.chip.kind &&
      this.chip.label === other.chip.label &&
      this.chip.icon === other.chip.icon &&
      this.chip.avatarUrl === other.chip.avatarUrl
    );
  }
  toDOM() {
    const chip = document.createElement("span");
    chip.className = `composer-chip composer-chip--${this.chip.kind}`;
    chip.setAttribute("role", "img");
    chip.setAttribute(
      "aria-label",
      t(this.chip.kind === "skill" ? "chat.composer.skillChip" : "chat.composer.mentionChip", {
        name: this.chip.label,
      }),
    );
    chip.contentEditable = "false";
    const icon = document.createElement("span");
    icon.className = "composer-chip__icon";
    icon.setAttribute("aria-hidden", "true");
    if (this.chip.avatarUrl) {
      const avatar = document.createElement("img");
      avatar.src = this.chip.avatarUrl;
      avatar.alt = "";
      icon.append(avatar);
    } else if (this.chip.icon) {
      render(this.chip.icon, icon);
    } else {
      icon.textContent = this.chip.kind === "skill" ? "$" : "@";
    }
    const label = document.createElement("bdi");
    label.className = "composer-chip__label";
    label.textContent = this.chip.label;
    chip.append(icon, label);
    return chip;
  }
  override ignoreEvent() {
    return false;
  }
}

/** User edits may leave a token unfinished at the caret; restoration and refresh confirm tokens. */
export type ComposerChipContext = { editing: boolean; caret: number };
export type ComposerChipResolver = (
  value: string,
  context: ComposerChipContext,
) => readonly ComposerChip[];
export const chipResolver =
  Facet.define<
    (value: string, context: ComposerChipContext) => readonly ComposerChip[] | undefined
  >();
export const setChips = StateEffect.define<readonly ComposerChip[]>();
export const chipDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(previous, transaction) {
    let decorations = previous.map(transaction.changes);
    const resolved = transaction.docChanged
      ? transaction.state.facet(chipResolver)[0]?.(transaction.newDoc.toString(), {
          editing:
            transaction.isUserEvent("input") &&
            !transaction.isUserEvent("input.paste") &&
            !transaction.isUserEvent("input.drop"),
          caret: transaction.newSelection.main.head,
        })
      : undefined;
    const effects = resolved
      ? [...transaction.effects, setChips.of(resolved)]
      : transaction.effects;
    for (const effect of effects) {
      if (effect.is(setChips)) {
        let previousEnd = 0;
        const ranges = [];
        for (const chip of effect.value.toSorted((a, b) => a.start - b.start)) {
          if (
            chip.start < previousEnd ||
            chip.end <= chip.start ||
            chip.end > transaction.newDoc.length
          ) {
            continue;
          }
          ranges.push(
            Decoration.replace({ widget: new ChipWidget(chip) }).range(chip.start, chip.end),
          );
          previousEnd = chip.end;
        }
        decorations = Decoration.set(ranges);
      }
    }
    return decorations;
  },
  provide: (field) => [
    EditorView.decorations.from(field),
    EditorView.atomicRanges.of((view) => view.state.field(field)),
  ],
});

// atomicRanges protects navigation. The dispatch owner also normalizes the final
// selection after every update, including history transactions that bypass filters.
export function normalizeChipSelection(state: EditorState) {
  const decorations = state.field(chipDecorations);
  const selection = state.selection;
  const ranges = selection.ranges.map((range) => {
    let start = range.from,
      end = range.to;
    decorations.between(range.from, range.to, (from, to) => {
      if (range.empty && from < start && start < to) {
        start = end = start - from < to - start ? from : to;
      } else if (!range.empty) {
        if (from < start && start < to) {
          start = from;
        }
        if (from < end && end < to) {
          end = to;
        }
      }
    });
    if (start === range.from && end === range.to) {
      return range;
    }
    return EditorSelection.range(
      range.anchor > range.head ? end : start,
      range.anchor > range.head ? start : end,
      range.goalColumn,
      range.bidiLevel ?? undefined,
      range.assoc,
    );
  });
  return EditorSelection.create(ranges, selection.mainIndex);
}
