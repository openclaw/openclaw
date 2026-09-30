import {
  type Component,
  type Focusable,
  fuzzyFilter,
  Input,
  isKeyRelease,
  matchesKey,
  type SelectItem,
  type SelectListTheme,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { iterateAnsiSegments } from "../../../packages/terminal-core/src/ansi-sequences.js";
import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import { escapeRegExp } from "../../shared/regexp.js";
import { sanitizeRenderableLine } from "../tui-formatters.js";

export interface SearchableSelectListTheme extends SelectListTheme {
  searchPrompt: (text: string) => string;
  searchInput: (text: string) => string;
  matchHighlight: (text: string) => string;
}

export interface SearchableSelectItem extends SelectItem {
  searchText?: string;
}

export class SearchableSelectList implements Component, Focusable {
  private items: SearchableSelectItem[];
  private preparedItems?: Array<{
    item: SearchableSelectItem;
    label: string;
    description: string;
    searchText: string;
  }>;
  private filteredItems: SearchableSelectItem[];
  private selectedIndex = 0;
  private retainedSelection?: string;
  private maxVisible: number;
  private theme: SearchableSelectListTheme;
  private searchInput: Input;
  private highlightPatterns?: RegExp[];
  private emptyMessage = "No matches";

  onSelect?: (item: SearchableSelectItem) => void;
  onCancel?: () => void;

  private static readonly DESCRIPTION_LAYOUT_MIN_WIDTH = 40;
  private static readonly DESCRIPTION_MIN_WIDTH = 12;
  private static readonly DESCRIPTION_SPACING_WIDTH = 2;
  // Keep a small right margin so we don't risk wrapping due to styling/terminal quirks.
  private static readonly RIGHT_MARGIN_WIDTH = 2;

  constructor(items: SearchableSelectItem[], maxVisible: number, theme: SearchableSelectListTheme) {
    this.items = items;
    this.filteredItems = items;
    this.maxVisible = maxVisible;
    this.theme = theme;
    this.searchInput = new Input();
    this.searchInput.onEscape = () => this.onCancel?.();
  }

  get focused(): boolean {
    return this.searchInput.focused;
  }

  set focused(value: boolean) {
    this.searchInput.focused = value;
  }

  setItems(items: SearchableSelectItem[], emptyMessage = "No matches", fallbackValue?: string) {
    // Invalidation can clear the rows before a replacement catalog arrives.
    const selectedValue = this.filteredItems[this.selectedIndex]?.value ?? this.retainedSelection;
    this.items = items;
    this.emptyMessage = sanitizeRenderableLine(emptyMessage);
    this.preparedItems = undefined;
    this.updateFilter();
    const selectedIndex = this.filteredItems.findIndex((item) => item.value === selectedValue);
    this.selectedIndex =
      selectedIndex >= 0
        ? selectedIndex
        : Math.max(
            0,
            this.filteredItems.findIndex((item) => item.value === fallbackValue),
          );
    this.retainedSelection = this.filteredItems[this.selectedIndex]?.value ?? selectedValue;
  }

  private updateFilter() {
    const query = this.searchInput.getValue().trim();

    if (!query) {
      this.filteredItems = this.items;
    } else {
      this.filteredItems = this.smartFilter(query);
    }

    this.selectedIndex = 0;
  }

  // Rank exact label matches before description matches, then fuzzy matches.
  private smartFilter(query: string): SearchableSelectItem[] {
    const q = normalizeLowercaseStringOrEmpty(query);
    type ScoredItem = { item: SearchableSelectItem; tier: number; score: number };
    type FuzzyCandidate = { item: SearchableSelectItem; searchText: string };
    const scoredItems: ScoredItem[] = [];
    const fuzzyCandidates: FuzzyCandidate[] = [];

    // Defer search projection until it is needed; setItems retires the old projection.
    this.preparedItems ??= this.items.map((item) => {
      const label = stripAnsi(this.getItemLabel(item));
      const description = stripAnsi(item.description ?? "");
      const searchText = stripAnsi(item.searchText ?? "");
      return {
        item,
        label: normalizeLowercaseStringOrEmpty(label),
        description: normalizeLowercaseStringOrEmpty(description),
        searchText: normalizeLowercaseStringOrEmpty(
          [label, description, searchText].filter((value) => value.length > 0).join(" "),
        ),
      };
    });
    for (const prepared of this.preparedItems) {
      const labelIndex = prepared.label.indexOf(q);
      if (labelIndex !== -1) {
        scoredItems.push({ item: prepared.item, tier: 0, score: labelIndex });
        continue;
      }
      const descIndex = prepared.description.indexOf(q);
      if (descIndex !== -1) {
        scoredItems.push({ item: prepared.item, tier: 1, score: descIndex });
        continue;
      }
      fuzzyCandidates.push(prepared);
    }

    scoredItems.sort(this.compareByScore);
    const fuzzyMatches = fuzzyFilter(fuzzyCandidates, q, (entry) => entry.searchText);
    return [...scoredItems.map((s) => s.item), ...fuzzyMatches.map((entry) => entry.item)];
  }

  private compareByScore = (
    a: { item: SearchableSelectItem; tier: number; score: number },
    b: { item: SearchableSelectItem; tier: number; score: number },
  ) => {
    return (
      a.tier - b.tier ||
      a.score - b.score ||
      this.getItemLabel(a.item).localeCompare(this.getItemLabel(b.item))
    );
  };

  private getItemLabel(item: SearchableSelectItem): string {
    return item.label || item.value;
  }

  private highlightMatch(text: string, patterns: RegExp[]): string {
    if (patterns.length === 0) {
      return text;
    }

    let parts = [...iterateAnsiSegments(text)];
    for (const regex of patterns) {
      const nextParts: typeof parts = [];
      for (const part of parts) {
        if (part.kind === "ansi") {
          nextParts.push(part);
          continue;
        }
        regex.lastIndex = 0;
        const replaced = part.value.replace(regex, (match) => this.theme.matchHighlight(match));
        if (replaced === part.value) {
          nextParts.push(part);
          continue;
        }
        nextParts.push(...iterateAnsiSegments(replaced));
      }
      parts = nextParts;
    }
    return parts.map((part) => part.value).join("");
  }

  invalidate() {
    this.searchInput.invalidate();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const safeWidth = Math.max(0, width);

    const promptText = "search: ";
    const prompt = this.theme.searchPrompt(promptText);
    const inputWidth = Math.max(0, safeWidth - visibleWidth(prompt));
    const inputLines = this.searchInput.render(inputWidth);
    const inputText = inputLines[0] ?? "";
    lines.push(truncateToWidth(`${prompt}${this.theme.searchInput(inputText)}`, safeWidth, ""));
    lines.push("");

    const query = this.searchInput.getValue().trim();

    if (this.filteredItems.length === 0) {
      const message = this.items.length === 0 ? this.emptyMessage : "No matches";
      lines.push(truncateToWidth(this.theme.noMatch(`  ${message}`), safeWidth, ""));
      return lines;
    }

    // One query owns these patterns; a render keeps its snapshot through theme callbacks.
    const patterns = (this.highlightPatterns ??= uniqueStrings(
      query
        .split(/\s+/)
        .map((token) => normalizeLowercaseStringOrEmpty(token))
        .filter((token) => token.length > 0),
    )
      .toSorted((a, b) => b.length - a.length)
      .map((token) => new RegExp(escapeRegExp(token), "gi")));

    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(this.maxVisible / 2),
        this.filteredItems.length - this.maxVisible,
      ),
    );
    const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);

    for (let i = startIndex; i < endIndex; i++) {
      const item = this.filteredItems[i];
      if (!item) {
        continue;
      }
      const isSelected = i === this.selectedIndex;
      lines.push(
        truncateToWidth(this.renderItemLine(item, isSelected, safeWidth, patterns), safeWidth, ""),
      );
    }

    if (this.filteredItems.length > this.maxVisible) {
      const scrollInfo = `${this.selectedIndex + 1}/${this.filteredItems.length}`;
      lines.push(truncateToWidth(this.theme.scrollInfo(`  ${scrollInfo}`), safeWidth, ""));
    }

    return lines;
  }

  private renderItemLine(
    item: SearchableSelectItem,
    isSelected: boolean,
    width: number,
    patterns: RegExp[],
  ): string {
    const prefix = isSelected ? "→ " : "  ";
    const prefixWidth = prefix.length;
    const displayValue =
      sanitizeRenderableLine(this.getItemLabel(item)) ||
      sanitizeRenderableLine(item.value) ||
      "(unnamed)";

    const description = sanitizeRenderableLine(item.description ?? "");
    if (description) {
      const descriptionLayout = this.getDescriptionLayout(width, prefixWidth);
      if (descriptionLayout) {
        const truncatedValue = truncateToWidth(displayValue, descriptionLayout.maxValueWidth, "");
        const valueText = this.highlightMatch(truncatedValue, patterns);

        const usedByValue = visibleWidth(valueText);
        const remainingWidth = descriptionLayout.availableWidth - usedByValue;
        const descriptionWidth = remainingWidth - descriptionLayout.spacingWidth;

        if (descriptionWidth >= SearchableSelectList.DESCRIPTION_MIN_WIDTH) {
          const spacing = " ".repeat(descriptionLayout.spacingWidth);
          const truncatedDesc = truncateToWidth(description, descriptionWidth, "");
          // Highlight plain text first, then apply theme styling to avoid corrupting ANSI codes
          const highlightedDesc = this.highlightMatch(truncatedDesc, patterns);
          const descText = isSelected ? highlightedDesc : this.theme.description(highlightedDesc);
          const line = `${prefix}${valueText}${spacing}${descText}`;
          return isSelected ? this.theme.selectedText(line) : line;
        }
      }
    }

    const maxWidth = width - prefixWidth - 2;
    const truncatedValue = truncateToWidth(displayValue, maxWidth, "");
    const valueText = this.highlightMatch(truncatedValue, patterns);
    const line = `${prefix}${valueText}`;
    return isSelected ? this.theme.selectedText(line) : line;
  }

  private getDescriptionLayout(
    width: number,
    prefixWidth: number,
  ): { availableWidth: number; maxValueWidth: number; spacingWidth: number } | null {
    if (width <= SearchableSelectList.DESCRIPTION_LAYOUT_MIN_WIDTH) {
      return null;
    }

    const availableWidth = width - prefixWidth - SearchableSelectList.RIGHT_MARGIN_WIDTH;
    const maxValueWidth =
      availableWidth -
      SearchableSelectList.DESCRIPTION_MIN_WIDTH -
      SearchableSelectList.DESCRIPTION_SPACING_WIDTH;

    return {
      availableWidth,
      maxValueWidth,
      spacingWidth: SearchableSelectList.DESCRIPTION_SPACING_WIDTH,
    };
  }

  handleInput(keyData: string): void {
    if (isKeyRelease(keyData)) {
      return;
    }

    if (matchesKey(keyData, "up") || matchesKey(keyData, "ctrl+p")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }

    if (matchesKey(keyData, "down") || matchesKey(keyData, "ctrl+n")) {
      this.selectedIndex = Math.min(this.filteredItems.length - 1, this.selectedIndex + 1);
      return;
    }

    if (matchesKey(keyData, "enter")) {
      const item = this.filteredItems[this.selectedIndex];
      if (item && this.onSelect) {
        this.onSelect(item);
      }
      return;
    }

    const prevValue = this.searchInput.getValue();
    this.searchInput.handleInput(keyData);
    const newValue = this.searchInput.getValue();

    if (prevValue !== newValue) {
      // Only current-query patterns are reusable; retaining older edits grows without bound.
      this.highlightPatterns = undefined;
      this.updateFilter();
    }
  }
}
