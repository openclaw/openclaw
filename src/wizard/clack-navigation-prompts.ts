import { styleText } from "node:util";
import {
  AutocompletePrompt,
  ConfirmPrompt,
  MultiSelectPrompt,
  PasswordPrompt,
  SelectPrompt,
  settings as clackSettings,
  TextPrompt,
  wrapTextWithPrefix,
} from "@clack/core";
import {
  S_BAR,
  S_BAR_END,
  S_CHECKBOX_ACTIVE,
  S_CHECKBOX_INACTIVE,
  S_CHECKBOX_SELECTED,
  S_PASSWORD_MASK,
  S_RADIO_ACTIVE,
  S_RADIO_INACTIVE,
  limitOptions,
  symbol as clackSymbol,
  symbolBar as clackSymbolBar,
  type AutocompleteMultiSelectOptions,
  type AutocompleteOptions,
  type ConfirmOptions,
  type MultiSelectOptions,
  type Option,
  type PasswordOptions,
  type SelectOptions,
  type TextOptions,
} from "@clack/prompts";
import { expectDefined } from "@openclaw/normalization-core";
import type { WizardPromptNavigation } from "./prompts.js";

type NavigationPromptOptions<Options> = Omit<Options, "withGuide" | "maxItems"> & {
  navigation?: WizardPromptNavigation;
};

function getOptionLabel<Value>(option: Option<Value>): string {
  return option.label ?? String(option.value ?? "");
}

function computeLabel(label: string, style: Parameters<typeof styleText>[0]): string {
  return label
    .split("\n")
    .map((text) => styleText(style, text))
    .join("\n");
}

function navigationFooterLines(
  guideVisible: boolean,
  barStyle: "cyan" | "yellow",
  navigation: WizardPromptNavigation | undefined,
  extraHints: string[] = [],
): string[] {
  if (!navigation || (!navigation.canGoBack && !navigation.canGoForward)) {
    return [];
  }
  const hintLine = [
    ...(navigation.canGoBack ? [styleText("dim", "← back")] : []),
    ...(navigation.canGoForward ? [styleText("dim", "→ next")] : []),
    ...extraHints,
  ].join("  ");
  const prefix = guideVisible ? `${styleText(barStyle, S_BAR)}  ` : "";
  return [`${prefix}${hintLine}`];
}

function renderChoiceOption<Value>(
  option: Option<Value>,
  state:
    | "inactive"
    | "active"
    | "selected"
    | "active-selected"
    | "submitted"
    | "cancelled"
    | "disabled",
  multiple = false,
): string {
  const label = getOptionLabel(option);
  if (state === "cancelled" || state === "submitted") {
    return computeLabel(label, state === "cancelled" ? ["strikethrough", "dim"] : "dim");
  }
  const active = state === "active" || state === "active-selected";
  const selected = state === "selected" || state === "active-selected";
  const disabled = state === "disabled";
  const inactiveSymbol = multiple ? S_CHECKBOX_INACTIVE : S_RADIO_INACTIVE;
  const symbol = selected
    ? S_CHECKBOX_SELECTED
    : active
      ? multiple
        ? S_CHECKBOX_ACTIVE
        : S_RADIO_ACTIVE
      : inactiveSymbol;
  const color = disabled
    ? "gray"
    : selected || (active && !multiple)
      ? "green"
      : active
        ? "cyan"
        : "dim";
  const renderedLabel = active
    ? label
    : computeLabel(label, disabled ? (multiple ? ["strikethrough", "gray"] : "gray") : "dim");
  const hint =
    (active || selected || disabled) && option.hint
      ? ` ${styleText("dim", `(${option.hint})`)}`
      : "";
  return `${styleText(color, symbol)} ${renderedLabel}${hint}`;
}

export function selectWithNavigationFooter<Value>(
  opts: NavigationPromptOptions<SelectOptions<Value>>,
): Promise<Value | symbol> {
  return new SelectPrompt({
    options: opts.options as Array<Option<Value>>,
    signal: opts.signal,
    input: opts.input,
    output: opts.output,
    initialValue: opts.initialValue,
    render() {
      const showGuide = clackSettings.withGuide;
      const titlePrefix = `${clackSymbol(this.state)}  `;
      const titlePrefixBar = `${clackSymbolBar(this.state)}  `;
      const messageLines = wrapTextWithPrefix(
        opts.output,
        opts.message,
        titlePrefixBar,
        titlePrefix,
      );
      const title = `${showGuide ? `${styleText("gray", S_BAR)}\n` : ""}${messageLines}\n`;

      switch (this.state) {
        case "submit":
        case "cancel": {
          const cancelled = this.state === "cancel";
          const prefix = showGuide ? `${styleText("gray", S_BAR)}  ` : "";
          const wrappedLines = wrapTextWithPrefix(
            opts.output,
            renderChoiceOption(
              expectDefined(this.options[this.cursor], "options entry at this.cursor"),
              cancelled ? "cancelled" : "submitted",
            ),
            prefix,
          );
          return `${title}${wrappedLines}${cancelled && showGuide ? `\n${styleText("gray", S_BAR)}` : ""}`;
        }
        default: {
          const prefix = showGuide ? `${styleText("cyan", S_BAR)}  ` : "";
          const footerLines = [
            ...navigationFooterLines(showGuide, "cyan", opts.navigation, [
              styleText("dim", "↑/↓ option"),
            ]),
            showGuide ? styleText("cyan", S_BAR_END) : "",
          ];
          const titleLineCount = title.split("\n").length;
          const footerLineCount = footerLines.length + 1;
          return `${title}${prefix}${limitOptions({
            output: opts.output,
            cursor: this.cursor,
            options: this.options,
            columnPadding: prefix.length,
            rowPadding: titleLineCount + footerLineCount,
            style: (item, active) =>
              renderChoiceOption(item, item.disabled ? "disabled" : active ? "active" : "inactive"),
          }).join(`\n${prefix}`)}\n${footerLines.join("\n")}\n`;
        }
      }
    },
  }).prompt() as Promise<Value | symbol>;
}

function renderAutocompleteOption<Value>(
  prompt: Omit<AutocompletePrompt<Option<Value>>, "prompt">,
  option: Option<Value>,
  active: boolean,
): string {
  const label = getOptionLabel(option);
  const hint =
    option.hint &&
    option.value === prompt.focusedValue &&
    (!prompt.multiple || prompt.focusedValue !== undefined)
      ? styleText("dim", ` (${option.hint})`)
      : "";
  const inactiveSymbol = prompt.multiple ? S_CHECKBOX_INACTIVE : S_RADIO_INACTIVE;
  if (option.disabled) {
    return `${styleText("gray", inactiveSymbol)} ${styleText(["strikethrough", "gray"], label)}`;
  }
  const selected = prompt.multiple && prompt.selectedValues.includes(option.value);
  const symbol = selected
    ? styleText("green", S_CHECKBOX_SELECTED)
    : active && !prompt.multiple
      ? styleText("green", S_RADIO_ACTIVE)
      : styleText("dim", inactiveSymbol);
  return `${symbol} ${active ? `${label}${hint}` : styleText("dim", label)}`;
}

function renderAutocomplete<Value>(
  prompt: Omit<AutocompletePrompt<Option<Value>>, "prompt">,
  opts: NavigationPromptOptions<Pick<AutocompleteOptions<Value>, "message" | "output">>,
): string {
  const showGuide = clackSettings.withGuide;
  const headings = [
    ...(showGuide ? [styleText("gray", S_BAR)] : []),
    `${clackSymbol(prompt.state)}  ${opts.message}`,
  ];
  const title = `${headings.join("\n")}\n`;
  const userInput = prompt.userInput;
  if (prompt.state === "submit") {
    if (prompt.multiple) {
      return `${title}${showGuide ? `${styleText("gray", S_BAR)}  ` : ""}${styleText(
        "dim",
        `${prompt.selectedValues.length} items selected`,
      )}`;
    }
    const selected = prompt.options.filter((option) =>
      prompt.selectedValues.includes(option.value),
    );
    const label =
      selected.length > 0 ? `  ${styleText("dim", selected.map(getOptionLabel).join(", "))}` : "";
    return `${title}${showGuide ? styleText("gray", S_BAR) : ""}${label}`;
  }
  if (prompt.state === "cancel") {
    if (prompt.multiple) {
      return `${title}${showGuide ? `${styleText("gray", S_BAR)}  ` : ""}${styleText(
        ["strikethrough", "dim"],
        userInput,
      )}`;
    }
    const input = userInput ? `  ${styleText(["strikethrough", "dim"], userInput)}` : "";
    return `${title}${showGuide ? styleText("gray", S_BAR) : ""}${input}`;
  }

  const barStyle = prompt.state === "error" ? "yellow" : "cyan";
  const guidePrefix = showGuide ? `${styleText(barStyle, S_BAR)}  ` : "";
  const searchText = prompt.isNavigating ? styleText("dim", userInput) : prompt.userInputWithCursor;
  // Multiselect reserves an empty guide row and a search separator even without a guide/input.
  if (showGuide || prompt.multiple) {
    headings.push(showGuide ? styleText(barStyle, S_BAR) : "");
  }
  const searchSuffix = prompt.multiple || !prompt.isNavigating || userInput ? ` ${searchText}` : "";
  const matches =
    prompt.filteredOptions.length !== prompt.options.length
      ? styleText(
          "dim",
          ` (${prompt.filteredOptions.length} match${prompt.filteredOptions.length === 1 ? "" : "es"})`,
        )
      : "";
  headings.push(`${guidePrefix}${styleText("dim", "Search:")}${searchSuffix}${matches}`);
  if (prompt.filteredOptions.length === 0 && userInput) {
    headings.push(`${guidePrefix}${styleText("yellow", "No matches found")}`);
  }
  if (prompt.state === "error") {
    headings.push(`${guidePrefix}${styleText("yellow", prompt.error)}`);
  }
  const instructions = [
    `${styleText("dim", "↑/↓")} to ${prompt.multiple ? "navigate" : "select"}`,
    ...(prompt.multiple
      ? [`${styleText("dim", prompt.isNavigating ? "Space/Tab:" : "Tab:")} select`]
      : []),
    `${styleText("dim", "Enter:")} confirm`,
    `${styleText("dim", "Type:")} to search`,
  ];
  const footers = [
    `${guidePrefix}${instructions.join(" • ")}`,
    ...navigationFooterLines(showGuide, barStyle, opts.navigation),
    showGuide ? styleText(barStyle, S_BAR_END) : "",
  ];
  const displayOptions =
    !prompt.multiple && prompt.filteredOptions.length === 0
      ? []
      : limitOptions({
          cursor: prompt.cursor,
          options: prompt.filteredOptions,
          ...(!prompt.multiple ? { columnPadding: showGuide ? 3 : 0 } : {}),
          rowPadding: headings.length + footers.length,
          style: (option, active) => renderAutocompleteOption(prompt, option, active),
          output: opts.output,
        });
  return [
    ...headings,
    ...displayOptions.map((option) => `${guidePrefix}${option}`),
    ...footers,
  ].join("\n");
}

export function autocompleteWithNavigationFooter<Value>(
  opts: NavigationPromptOptions<
    Omit<AutocompleteOptions<Value>, "initialUserInput" | "placeholder">
  >,
): Promise<Value | symbol> {
  return new AutocompletePrompt<Option<Value>>({
    options: opts.options as Array<Option<Value>>,
    initialValue: opts.initialValue === undefined ? undefined : [opts.initialValue],
    filter: opts.filter,
    signal: opts.signal,
    input: opts.input,
    output: opts.output,
    validate: opts.validate,
    render() {
      return renderAutocomplete(this, opts);
    },
  }).prompt() as Promise<Value | symbol>;
}

function renderTextPrompt(
  prompt: Pick<TextPrompt, "state" | "error">,
  opts: NavigationPromptOptions<Pick<TextOptions, "message">>,
  input: string,
  value: string,
  masked = false,
): string {
  const showGuide = clackSettings.withGuide;
  const bar = showGuide ? styleText("gray", S_BAR) : "";
  const title = `${showGuide ? `${bar}\n` : ""}${clackSymbol(prompt.state)}  ${opts.message}\n`;
  if (prompt.state === "submit" || prompt.state === "cancel") {
    const cancelled = prompt.state === "cancel";
    // Password prompts reserve value padding even when empty; text prompts do not.
    const padding = masked ? (showGuide ? "  " : "") : value ? "  " : "";
    const valueText = value ? styleText(cancelled ? ["strikethrough", "dim"] : "dim", value) : "";
    const trailingBar = cancelled && (masked ? value && showGuide : value.trim());
    return `${title}${bar}${padding}${valueText}${trailingBar ? `\n${bar}` : ""}`;
  }
  const failed = prompt.state === "error";
  const color = failed ? "yellow" : "cyan";
  const prefix = showGuide ? `${styleText(color, S_BAR)}  ` : "";
  const end = showGuide ? `${styleText(color, S_BAR_END)}${failed && masked ? "  " : ""}` : "";
  const footerLines = navigationFooterLines(showGuide, color, opts.navigation);
  const errorText = failed
    ? masked
      ? styleText("yellow", prompt.error)
      : prompt.error
        ? `  ${styleText("yellow", prompt.error)}`
        : ""
    : "";
  return `${failed ? `${title.trim()}\n` : title}${prefix}${failed && masked ? value : input}\n${
    footerLines.length ? `${footerLines.join("\n")}\n` : ""
  }${end}${errorText}\n`;
}

export function textWithNavigationFooter(
  opts: NavigationPromptOptions<Omit<TextOptions, "defaultValue">>,
): Promise<string | symbol> {
  return new TextPrompt({
    validate: opts.validate,
    placeholder: opts.placeholder,
    initialValue: opts.initialValue,
    output: opts.output,
    signal: opts.signal,
    input: opts.input,
    render() {
      const placeholder = opts.placeholder
        ? styleText("inverse", opts.placeholder[0] ?? "") +
          styleText("dim", opts.placeholder.slice(1))
        : styleText(["inverse", "hidden"], "_");
      return renderTextPrompt(
        this,
        opts,
        this.userInput ? this.userInputWithCursor : placeholder,
        this.value ?? "",
      );
    },
  }).prompt() as Promise<string | symbol>;
}

export function passwordWithNavigationFooter(
  opts: NavigationPromptOptions<Omit<PasswordOptions, "mask" | "clearOnError">>,
): Promise<string | symbol> {
  return new PasswordPrompt({
    validate: opts.validate,
    mask: S_PASSWORD_MASK,
    signal: opts.signal,
    input: opts.input,
    output: opts.output,
    render() {
      return renderTextPrompt(this, opts, this.userInputWithCursor, this.masked ?? "", true);
    },
  }).prompt() as Promise<string | symbol>;
}

export function multiselectWithNavigationFooter<Value>(
  opts: NavigationPromptOptions<Omit<MultiSelectOptions<Value>, "required" | "cursorAt">>,
): Promise<Value[] | symbol> {
  return new MultiSelectPrompt({
    options: opts.options as Array<Option<Value>>,
    signal: opts.signal,
    input: opts.input,
    output: opts.output,
    initialValues: opts.initialValues,
    validate(selected: Value[] | undefined) {
      if (selected === undefined || selected.length === 0) {
        return `Please select at least one option.\n${styleText(
          "reset",
          styleText(
            "dim",
            `Press ${styleText(["gray", "bgWhite", "inverse"], " space ")} to select, ${styleText(
              "gray",
              styleText("bgWhite", styleText("inverse", " enter ")),
            )} to submit`,
          ),
        )}`;
      }
      return undefined;
    },
    render() {
      const showGuide = clackSettings.withGuide;
      const wrappedMessage = wrapTextWithPrefix(
        opts.output,
        opts.message,
        showGuide ? `${clackSymbolBar(this.state)}  ` : "",
        `${clackSymbol(this.state)}  `,
      );
      const title = `${showGuide ? `${styleText("gray", S_BAR)}\n` : ""}${wrappedMessage}\n`;
      const value = this.value ?? [];
      const styleOption = (option: Option<Value>, active: boolean) => {
        if (option.disabled) {
          return renderChoiceOption(option, "disabled", true);
        }
        const selected = value.includes(option.value);
        if (active && selected) {
          return renderChoiceOption(option, "active-selected", true);
        }
        if (selected) {
          return renderChoiceOption(option, "selected", true);
        }
        return renderChoiceOption(option, active ? "active" : "inactive", true);
      };

      switch (this.state) {
        case "submit": {
          const submitText =
            this.options
              .filter(({ value: optionValue }) => value.includes(optionValue))
              .map((option) => renderChoiceOption(option, "submitted", true))
              .join(styleText("dim", ", ")) || styleText("dim", "none");
          const wrappedSubmitText = wrapTextWithPrefix(
            opts.output,
            submitText,
            showGuide ? `${styleText("gray", S_BAR)}  ` : "",
          );
          return `${title}${wrappedSubmitText}`;
        }
        case "cancel": {
          const label = this.options
            .filter(({ value: optionValue }) => value.includes(optionValue))
            .map((option) => renderChoiceOption(option, "cancelled", true))
            .join(styleText("dim", ", "));
          if (label.trim() === "") {
            return `${title}${styleText("gray", S_BAR)}`;
          }
          const wrappedLabel = wrapTextWithPrefix(
            opts.output,
            label,
            showGuide ? `${styleText("gray", S_BAR)}  ` : "",
          );
          return `${title}${wrappedLabel}${showGuide ? `\n${styleText("gray", S_BAR)}` : ""}`;
        }
        default: {
          const barStyle = this.state === "error" ? "yellow" : "cyan";
          const prefix = showGuide ? `${styleText(barStyle, S_BAR)}  ` : "";
          const footerLines =
            this.state === "error"
              ? this.error
                  .split("\n")
                  .map((line, index) =>
                    index === 0
                      ? `${showGuide ? `${styleText("yellow", S_BAR_END)}  ` : ""}${styleText(
                          "yellow",
                          line,
                        )}`
                      : `   ${line}`,
                  )
              : [
                  ...navigationFooterLines(showGuide, "cyan", opts.navigation, [
                    styleText("dim", "↑/↓ option"),
                    styleText("dim", "space select"),
                  ]),
                  showGuide ? styleText("cyan", S_BAR_END) : "",
                ];
          const titleLineCount = title.split("\n").length;
          const footerLineCount = footerLines.length + 1;
          return `${title}${prefix}${limitOptions({
            output: opts.output,
            options: this.options,
            cursor: this.cursor,
            columnPadding: prefix.length,
            rowPadding: titleLineCount + footerLineCount,
            style: styleOption,
          }).join(`\n${prefix}`)}\n${footerLines.join("\n")}\n`;
        }
      }
    },
  }).prompt() as Promise<Value[] | symbol>;
}

export function autocompleteMultiselectWithNavigationFooter<Value>(
  opts: NavigationPromptOptions<
    Omit<AutocompleteMultiSelectOptions<Value>, "required" | "placeholder">
  >,
): Promise<Value[] | symbol> {
  return new AutocompletePrompt<Option<Value>>({
    options: opts.options as Array<Option<Value>>,
    multiple: true,
    filter: opts.filter,
    initialValue: opts.initialValues,
    signal: opts.signal,
    input: opts.input,
    output: opts.output,
    render() {
      return renderAutocomplete(this, opts);
    },
  }).prompt() as Promise<Value[] | symbol>;
}

export function confirmWithNavigationFooter(
  opts: NavigationPromptOptions<Omit<ConfirmOptions, "active" | "inactive">>,
): Promise<boolean | symbol> {
  const active = "Yes";
  const inactive = "No";
  return new ConfirmPrompt({
    active,
    inactive,
    signal: opts.signal,
    input: opts.input,
    output: opts.output,
    initialValue: opts.initialValue ?? true,
    render() {
      const showGuide = clackSettings.withGuide;
      const titlePrefix = `${clackSymbol(this.state)}  `;
      const titlePrefixBar = showGuide ? `${styleText("gray", S_BAR)}  ` : "";
      const messageLines = wrapTextWithPrefix(
        opts.output,
        opts.message,
        titlePrefixBar,
        titlePrefix,
      );
      const title = `${showGuide ? `${styleText("gray", S_BAR)}\n` : ""}${messageLines}\n`;
      const value = this.value ? active : inactive;

      switch (this.state) {
        case "submit": {
          const submitPrefix = showGuide ? `${styleText("gray", S_BAR)}  ` : "";
          return `${title}${submitPrefix}${styleText("dim", value)}`;
        }
        case "cancel": {
          const cancelPrefix = showGuide ? `${styleText("gray", S_BAR)}  ` : "";
          return `${title}${cancelPrefix}${styleText(["strikethrough", "dim"], value)}${
            showGuide ? `\n${styleText("gray", S_BAR)}` : ""
          }`;
        }
        default: {
          const defaultPrefix = showGuide ? `${styleText("cyan", S_BAR)}  ` : "";
          const defaultPrefixEnd = showGuide ? styleText("cyan", S_BAR_END) : "";
          const separator = opts.vertical
            ? showGuide
              ? `\n${styleText("cyan", S_BAR)}  `
              : "\n"
            : ` ${styleText("dim", "/")} `;
          const footerLines = navigationFooterLines(showGuide, "cyan", opts.navigation, [
            styleText("dim", "↑/↓ option"),
          ]);
          return `${title}${defaultPrefix}${
            this.value
              ? `${styleText("green", S_RADIO_ACTIVE)} ${active}`
              : `${styleText("dim", S_RADIO_INACTIVE)} ${styleText("dim", active)}`
          }${separator}${
            !this.value
              ? `${styleText("green", S_RADIO_ACTIVE)} ${inactive}`
              : `${styleText("dim", S_RADIO_INACTIVE)} ${styleText("dim", inactive)}`
          }\n${footerLines.length > 0 ? `${footerLines.join("\n")}\n` : ""}${defaultPrefixEnd}\n`;
        }
      }
    },
  }).prompt() as Promise<boolean | symbol>;
}
