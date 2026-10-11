/** Custom Clack multi-select prompt for Codex migration skill/plugin choices. */
import { styleText } from "node:util";
import { MultiSelectPrompt, settings, wrapTextWithPrefix } from "@clack/core";
import {
  limitOptions,
  S_BAR,
  S_BAR_END,
  S_CHECKBOX_ACTIVE,
  S_CHECKBOX_INACTIVE,
  S_CHECKBOX_SELECTED,
  symbol,
  symbolBar,
  type MultiSelectOptions,
  type Option,
} from "@clack/prompts";
import {
  MIGRATION_SELECTION_ACCEPT,
  reconcileInteractiveMigrationEnterValues,
  reconcileInteractiveMigrationShortcutValues,
  reconcileInteractiveMigrationSkillToggleValues,
} from "./selection.js";

/** Options for the migration selection prompt, including testable IO streams. */
type MigrationSelectionOption = Pick<Option<string>, "value" | "label" | "hint">;
type MigrationSkillSelectionPromptOptions = Pick<
  MultiSelectOptions<string>,
  "message" | "input" | "output" | "withGuide" | "initialValues" | "cursorAt"
> & {
  options: MigrationSelectionOption[];
  selectableValues: readonly string[];
};

function formatOption(
  option: MigrationSelectionOption,
  state: "active" | "active-selected" | "cancelled" | "inactive" | "selected" | "submitted",
): string {
  const label = option.label ?? option.value;
  const withHint = option.hint ? `${label} ${styleText("dim", `(${option.hint})`)}` : label;
  switch (state) {
    case "active":
      return `${styleText("cyan", S_CHECKBOX_ACTIVE)} ${withHint}`;
    case "active-selected":
      return `${styleText("green", S_CHECKBOX_SELECTED)} ${withHint}`;
    case "cancelled":
      return styleText(["strikethrough", "dim"], label);
    case "selected":
      return `${styleText("green", S_CHECKBOX_SELECTED)} ${styleText("dim", withHint)}`;
    case "submitted":
      return styleText("dim", label);
    default:
      return `${styleText("dim", S_CHECKBOX_INACTIVE)} ${styleText("dim", withHint)}`;
  }
}

/** Prompts for migration selection values and reconciles all/none/recommended shortcuts. */
export function promptMigrationSkillSelectionValues(
  opts: MigrationSkillSelectionPromptOptions,
): Promise<string[] | symbol | undefined> {
  const prompt = new MultiSelectPrompt<MigrationSelectionOption>({
    options: opts.options,
    input: opts.input,
    output: opts.output,
    initialValues: opts.initialValues,
    cursorAt: opts.cursorAt,
    render() {
      const withGuide = opts.withGuide ?? settings.withGuide;
      const message = wrapTextWithPrefix(
        opts.output,
        opts.message,
        withGuide ? `${symbolBar(this.state)}  ` : "",
        `${symbol(this.state)}  `,
      );
      const header = `${withGuide ? `${styleText("gray", S_BAR)}\n` : ""}${message}\n`;
      const value = this.value ?? [];
      const optionState = (option: MigrationSelectionOption, active: boolean) => {
        const selected = value.includes(option.value);
        if (active && selected) {
          return formatOption(option, "active-selected");
        }
        if (selected) {
          return formatOption(option, "selected");
        }
        return formatOption(option, active ? "active" : "inactive");
      };

      switch (this.state) {
        case "submit":
        case "cancel": {
          const selected = this.options
            .filter((option) => value.includes(option.value))
            .map((option) =>
              formatOption(option, this.state === "submit" ? "submitted" : "cancelled"),
            )
            .join(styleText("dim", ", "));
          if (this.state === "submit") {
            const label = selected || styleText("dim", "none");
            return `${header}${wrapTextWithPrefix(opts.output, label, withGuide ? `${styleText("gray", S_BAR)}  ` : "")}`;
          }
          if (selected.trim() === "") {
            return `${header}${styleText("gray", S_BAR)}`;
          }
          return `${header}${wrapTextWithPrefix(
            opts.output,
            selected,
            withGuide ? `${styleText("gray", S_BAR)}  ` : "",
          )}${withGuide ? `\n${styleText("gray", S_BAR)}` : ""}`;
        }
        default: {
          const prefix = withGuide ? `${styleText("cyan", S_BAR)}  ` : "";
          return `${header}${prefix}${limitOptions({
            output: opts.output,
            options: this.options,
            cursor: this.cursor,
            columnPadding: prefix.length,
            rowPadding: header.split("\n").length + (withGuide ? 2 : 1),
            style: optionState,
          }).join(`\n${prefix}`)}\n${withGuide ? styleText("cyan", S_BAR_END) : ""}\n`;
        }
      }
    },
  });
  let lastSelectedValues = [...(prompt.value ?? [])];
  let lastSpaceDeselectedValue: string | undefined;

  prompt.on("cursor", (key) => {
    if (key !== "space") {
      lastSpaceDeselectedValue = undefined;
      return;
    }
    const activatedValue = prompt.options[prompt.cursor]?.value;
    // Space on the "Accept recommended" sentinel snaps the visual selection
    // back to the recommended set so the user can see what would be submitted
    // by Enter. The sentinel itself is never persisted in the value list.
    if (activatedValue === MIGRATION_SELECTION_ACCEPT) {
      prompt.value = [...(opts.initialValues ?? [])];
      lastSpaceDeselectedValue = undefined;
      lastSelectedValues = [...(prompt.value ?? [])];
      return;
    }
    const previousValues = lastSelectedValues;
    const selectedValuesAfterClack = prompt.value ?? [];
    prompt.value = reconcileInteractiveMigrationSkillToggleValues(
      selectedValuesAfterClack,
      activatedValue,
      opts.selectableValues,
    );
    lastSpaceDeselectedValue =
      activatedValue !== undefined &&
      opts.selectableValues.includes(activatedValue) &&
      previousValues.includes(activatedValue) &&
      !(prompt.value ?? []).includes(activatedValue)
        ? activatedValue
        : undefined;
    lastSelectedValues = [...(prompt.value ?? [])];
  });

  prompt.on("key", (key, info) => {
    if (info.name === "return") {
      const activatedValue = prompt.options[prompt.cursor]?.value;
      // Enter on "Accept recommended" submits with the picker's initialValues
      // (the recommended set) regardless of any toggles the user made.
      if (activatedValue === MIGRATION_SELECTION_ACCEPT) {
        prompt.value = [...(opts.initialValues ?? [])];
      } else {
        prompt.value = reconcileInteractiveMigrationEnterValues(
          prompt.value ?? [],
          activatedValue,
          opts.selectableValues,
          {
            preserveDeselectedActivatedValue:
              activatedValue !== undefined &&
              activatedValue === lastSpaceDeselectedValue &&
              !(prompt.value ?? []).includes(activatedValue),
          },
        );
      }
      // Enter can submit the active row without a Space event; keep the local
      // selection cache aligned for subsequent shortcut reconciliation.
      lastSpaceDeselectedValue = undefined;
      lastSelectedValues = [...(prompt.value ?? [])];
      return;
    }
    if (key !== "a" && key !== "i") {
      return;
    }
    prompt.value = reconcileInteractiveMigrationShortcutValues(
      lastSelectedValues,
      prompt.value ?? [],
      opts.selectableValues,
      key,
    );
    lastSpaceDeselectedValue = undefined;
    lastSelectedValues = [...(prompt.value ?? [])];
  });

  return prompt.prompt();
}
