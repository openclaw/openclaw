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

type NavigationPromptOptions = {
  navigation?: WizardPromptNavigation;
};

function getOptionLabel<Value>(option: Option<Value>): string {
  return option.label ?? String(option.value ?? "");
}

function computeLabel(label: string, format: (text: string) => string): string {
  return label.split("\n").map(format).join("\n");
}

function getFilteredOption<Value>(searchText: string, option: Option<Value>): boolean {
  if (!searchText) {
    return true;
  }
  const term = searchText.toLowerCase();
  return (
    getOptionLabel(option).toLowerCase().includes(term) ||
    (option.hint ?? "").toLowerCase().includes(term) ||
    String(option.value).toLowerCase().includes(term)
  );
}

function formatNavigationFooter(navigation: WizardPromptNavigation | undefined): string {
  if (!navigation || (!navigation.canGoBack && !navigation.canGoForward)) {
    return "";
  }
  return [
    navigation.canGoBack ? styleText("dim", "← back") : undefined,
    navigation.canGoForward ? styleText("dim", "→ next") : undefined,
  ]
    .filter(Boolean)
    .join("  ");
}

function navigationFooterLines(
  guideVisible: boolean,
  barStyle: "cyan" | "yellow",
  navigation: WizardPromptNavigation | undefined,
  extraHints: string[] = [],
): string[] {
  const footer = formatNavigationFooter(navigation);
  if (!footer) {
    return [];
  }
  const hintLine = [footer, ...extraHints].join("  ");
  const prefix = guideVisible ? `${styleText(barStyle, S_BAR)}  ` : "";
  return [`${prefix}${hintLine}`];
}

function hasGuide(opts: { withGuide?: boolean }): boolean {
  return opts.withGuide ?? clackSettings.withGuide;
}

function selectOptionRenderer<Value>(option: Option<Value>, state: string): string {
  const label = getOptionLabel(option);
  switch (state) {
    case "disabled":
      return `${styleText("gray", S_RADIO_INACTIVE)} ${computeLabel(label, (text) => styleText("gray", text))}${
        option.hint ? ` ${styleText("dim", `(${option.hint})`)}` : ""
      }`;
    case "selected":
      return computeLabel(label, (text) => styleText("dim", text));
    case "active":
      return `${styleText("green", S_RADIO_ACTIVE)} ${label}${
        option.hint ? ` ${styleText("dim", `(${option.hint})`)}` : ""
      }`;
    case "cancelled":
      return computeLabel(label, (text) => styleText(["strikethrough", "dim"], text));
    default:
      return `${styleText("dim", S_RADIO_INACTIVE)} ${computeLabel(label, (text) =>
        styleText("dim", text),
      )}`;
  }
}

export function selectWithNavigationFooter<Value>(
  opts: SelectOptions<Value> & NavigationPromptOptions,
): Promise<Value | symbol> {
  return new SelectPrompt({
    options: opts.options as Array<Option<Value>>,
    signal: opts.signal,
    input: opts.input,
    output: opts.output,
    initialValue: opts.initialValue,
    render() {
      const showGuide = hasGuide(opts);
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
            selectOptionRenderer(
              expectDefined(this.options[this.cursor], "options entry at this.cursor"),
              cancelled ? "cancelled" : "selected",
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
            maxItems: opts.maxItems,
            columnPadding: prefix.length,
            rowPadding: titleLineCount + footerLineCount,
            style: (item, active) =>
              selectOptionRenderer(
                item,
                item.disabled ? "disabled" : active ? "active" : "inactive",
              ),
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
  opts: Pick<
    AutocompleteOptions<Value>,
    "message" | "withGuide" | "placeholder" | "maxItems" | "output"
  > &
    NavigationPromptOptions,
): string {
  const showGuide = hasGuide(opts);
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
  const showPlaceholder = userInput === "" && opts.placeholder !== undefined;
  const searchText =
    prompt.isNavigating || showPlaceholder
      ? styleText("dim", showPlaceholder ? (opts.placeholder ?? "") : userInput)
      : prompt.userInputWithCursor;
  // Multiselect reserves an empty guide row and a search separator even without a guide/input.
  if (showGuide || prompt.multiple) {
    headings.push(showGuide ? styleText(barStyle, S_BAR) : "");
  }
  const searchSuffix =
    prompt.multiple || !(prompt.isNavigating || showPlaceholder) || opts.placeholder || userInput
      ? ` ${searchText}`
      : "";
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
          maxItems: opts.maxItems,
          output: opts.output,
        });
  return [
    ...headings,
    ...displayOptions.map((option) => `${guidePrefix}${option}`),
    ...footers,
  ].join("\n");
}

export function autocompleteWithNavigationFooter<Value>(
  opts: AutocompleteOptions<Value> & NavigationPromptOptions,
): Promise<Value | symbol> {
  return new AutocompletePrompt<Option<Value>>({
    options: opts.options as Array<Option<Value>>,
    initialValue: opts.initialValue === undefined ? undefined : [opts.initialValue],
    initialUserInput: opts.initialUserInput,
    placeholder: opts.placeholder,
    filter: opts.filter ?? getFilteredOption,
    signal: opts.signal,
    input: opts.input,
    output: opts.output,
    validate: opts.validate,
    render() {
      return renderAutocomplete(this, opts);
    },
  }).prompt() as Promise<Value | symbol>;
}

export function textWithNavigationFooter(
  opts: TextOptions & NavigationPromptOptions,
): Promise<string | symbol> {
  return new TextPrompt({
    validate: opts.validate,
    placeholder: opts.placeholder,
    defaultValue: opts.defaultValue,
    initialValue: opts.initialValue,
    output: opts.output,
    signal: opts.signal,
    input: opts.input,
    render() {
      const showGuide = hasGuide(opts);
      const titlePrefix = `${showGuide ? `${styleText("gray", S_BAR)}\n` : ""}${clackSymbol(
        this.state,
      )}  `;
      const title = `${titlePrefix}${opts.message}\n`;
      const placeholder = opts.placeholder
        ? styleText("inverse", opts.placeholder[0] ?? "") +
          styleText("dim", opts.placeholder.slice(1))
        : styleText(["inverse", "hidden"], "_");
      const userInput = !this.userInput ? placeholder : this.userInputWithCursor;
      const value = this.value ?? "";

      switch (this.state) {
        case "error": {
          const errorText = this.error ? `  ${styleText("yellow", this.error)}` : "";
          const errorPrefix = showGuide ? `${styleText("yellow", S_BAR)}  ` : "";
          const errorPrefixEnd = showGuide ? styleText("yellow", S_BAR_END) : "";
          const footerLines = navigationFooterLines(showGuide, "yellow", opts.navigation);
          return `${title.trim()}\n${errorPrefix}${userInput}\n${
            footerLines.length ? `${footerLines.join("\n")}\n` : ""
          }${errorPrefixEnd}${errorText}\n`;
        }
        case "submit": {
          const valueText = value ? `  ${styleText("dim", value)}` : "";
          const submitPrefix = showGuide ? styleText("gray", S_BAR) : "";
          return `${title}${submitPrefix}${valueText}`;
        }
        case "cancel": {
          const valueText = value ? `  ${styleText(["strikethrough", "dim"], value)}` : "";
          const cancelPrefix = showGuide ? styleText("gray", S_BAR) : "";
          return `${title}${cancelPrefix}${valueText}${value.trim() ? `\n${cancelPrefix}` : ""}`;
        }
        default: {
          const defaultPrefix = showGuide ? `${styleText("cyan", S_BAR)}  ` : "";
          const defaultPrefixEnd = showGuide ? styleText("cyan", S_BAR_END) : "";
          const footerLines = navigationFooterLines(showGuide, "cyan", opts.navigation);
          return `${title}${defaultPrefix}${userInput}\n${
            footerLines.length ? `${footerLines.join("\n")}\n` : ""
          }${defaultPrefixEnd}\n`;
        }
      }
    },
  }).prompt() as Promise<string | symbol>;
}

export function passwordWithNavigationFooter(
  opts: PasswordOptions & NavigationPromptOptions,
): Promise<string | symbol> {
  return new PasswordPrompt({
    validate: opts.validate,
    mask: opts.mask ?? S_PASSWORD_MASK,
    signal: opts.signal,
    input: opts.input,
    output: opts.output,
    render() {
      const showGuide = hasGuide(opts);
      const title = `${showGuide ? `${styleText("gray", S_BAR)}\n` : ""}${clackSymbol(
        this.state,
      )}  ${opts.message}\n`;
      const userInput = this.userInputWithCursor;
      const masked = this.masked;

      switch (this.state) {
        case "error": {
          const errorPrefix = showGuide ? `${styleText("yellow", S_BAR)}  ` : "";
          const errorPrefixEnd = showGuide ? `${styleText("yellow", S_BAR_END)}  ` : "";
          const maskedText = masked ?? "";
          if (opts.clearOnError) {
            this.clear();
          }
          const footerLines = navigationFooterLines(showGuide, "yellow", opts.navigation);
          return `${title.trim()}\n${errorPrefix}${maskedText}\n${
            footerLines.length ? `${footerLines.join("\n")}\n` : ""
          }${errorPrefixEnd}${styleText("yellow", this.error)}\n`;
        }
        case "submit": {
          const submitPrefix = showGuide ? `${styleText("gray", S_BAR)}  ` : "";
          const maskedText = masked ? styleText("dim", masked) : "";
          return `${title}${submitPrefix}${maskedText}`;
        }
        case "cancel": {
          const cancelPrefix = showGuide ? `${styleText("gray", S_BAR)}  ` : "";
          const maskedText = masked ? styleText(["strikethrough", "dim"], masked) : "";
          return `${title}${cancelPrefix}${maskedText}${
            masked && showGuide ? `\n${styleText("gray", S_BAR)}` : ""
          }`;
        }
        default: {
          const defaultPrefix = showGuide ? `${styleText("cyan", S_BAR)}  ` : "";
          const defaultPrefixEnd = showGuide ? styleText("cyan", S_BAR_END) : "";
          const footerLines = navigationFooterLines(showGuide, "cyan", opts.navigation);
          return `${title}${defaultPrefix}${userInput}\n${
            footerLines.length ? `${footerLines.join("\n")}\n` : ""
          }${defaultPrefixEnd}\n`;
        }
      }
    },
  }).prompt() as Promise<string | symbol>;
}

function multiselectOptionRenderer<Value>(
  option: Option<Value>,
  state:
    | "inactive"
    | "active"
    | "selected"
    | "active-selected"
    | "submitted"
    | "cancelled"
    | "disabled",
): string {
  const label = getOptionLabel(option);
  if (state === "disabled") {
    return `${styleText("gray", S_CHECKBOX_INACTIVE)} ${computeLabel(label, (str) =>
      styleText(["strikethrough", "gray"], str),
    )}${option.hint ? ` ${styleText("dim", `(${option.hint})`)}` : ""}`;
  }
  if (state === "active") {
    return `${styleText("cyan", S_CHECKBOX_ACTIVE)} ${label}${
      option.hint ? ` ${styleText("dim", `(${option.hint})`)}` : ""
    }`;
  }
  if (state === "selected") {
    return `${styleText("green", S_CHECKBOX_SELECTED)} ${computeLabel(label, (text) =>
      styleText("dim", text),
    )}${option.hint ? ` ${styleText("dim", `(${option.hint})`)}` : ""}`;
  }
  if (state === "cancelled") {
    return computeLabel(label, (text) => styleText(["strikethrough", "dim"], text));
  }
  if (state === "active-selected") {
    return `${styleText("green", S_CHECKBOX_SELECTED)} ${label}${
      option.hint ? ` ${styleText("dim", `(${option.hint})`)}` : ""
    }`;
  }
  if (state === "submitted") {
    return computeLabel(label, (text) => styleText("dim", text));
  }
  return `${styleText("dim", S_CHECKBOX_INACTIVE)} ${computeLabel(label, (text) =>
    styleText("dim", text),
  )}`;
}

export function multiselectWithNavigationFooter<Value>(
  opts: MultiSelectOptions<Value> & NavigationPromptOptions,
): Promise<Value[] | symbol> {
  const required = opts.required ?? true;
  return new MultiSelectPrompt({
    options: opts.options as Array<Option<Value>>,
    signal: opts.signal,
    input: opts.input,
    output: opts.output,
    initialValues: opts.initialValues,
    cursorAt: opts.cursorAt,
    validate(selected: Value[] | undefined) {
      if (required && (selected === undefined || selected.length === 0)) {
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
      const showGuide = hasGuide(opts);
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
          return multiselectOptionRenderer(option, "disabled");
        }
        const selected = value.includes(option.value);
        if (active && selected) {
          return multiselectOptionRenderer(option, "active-selected");
        }
        if (selected) {
          return multiselectOptionRenderer(option, "selected");
        }
        return multiselectOptionRenderer(option, active ? "active" : "inactive");
      };

      switch (this.state) {
        case "submit": {
          const submitText =
            this.options
              .filter(({ value: optionValue }) => value.includes(optionValue))
              .map((option) => multiselectOptionRenderer(option, "submitted"))
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
            .map((option) => multiselectOptionRenderer(option, "cancelled"))
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
            maxItems: opts.maxItems,
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
  opts: AutocompleteMultiSelectOptions<Value> & NavigationPromptOptions,
): Promise<Value[] | symbol> {
  const prompt = new AutocompletePrompt<Option<Value>>({
    options: opts.options as Array<Option<Value>>,
    multiple: true,
    placeholder: opts.placeholder,
    filter: opts.filter ?? getFilteredOption,
    validate: () => {
      if (opts.required && prompt.selectedValues.length === 0) {
        return "Please select at least one item";
      }
      return undefined;
    },
    initialValue: opts.initialValues,
    signal: opts.signal,
    input: opts.input,
    output: opts.output,
    render() {
      return renderAutocomplete(this, opts);
    },
  });
  return prompt.prompt() as Promise<Value[] | symbol>;
}

export function confirmWithNavigationFooter(
  opts: ConfirmOptions & NavigationPromptOptions,
): Promise<boolean | symbol> {
  const active = opts.active ?? "Yes";
  const inactive = opts.inactive ?? "No";
  return new ConfirmPrompt({
    active,
    inactive,
    signal: opts.signal,
    input: opts.input,
    output: opts.output,
    initialValue: opts.initialValue ?? true,
    render() {
      const showGuide = hasGuide(opts);
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
