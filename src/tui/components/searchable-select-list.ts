import {
  type Component,
  getEditorKeybindings,
  Input,
  isKeyRelease,
  matchesKey,
  type SelectItem,
  type SelectListTheme,
  truncateToWidth,
} from "@mariozechner/pi-tui";
import { visibleWidth } from "../../terminal/ansi.js";
import { findWordBoundaryIndex, fuzzyFilterLower, prepareSearchItems } from "./fuzzy-filter.js";

export interface SearchableSelectListTheme extends SelectListTheme {
  searchPrompt: (text: string) => string;
  searchInput: (text: string) => string;
  matchHighlight: (text: string) => string;
}

/**
 * A select list with a search input at the top for fuzzy filtering.
 */
export class SearchableSelectList implements Component {
  private items: SelectItem[];
  private filteredItems: SelectItem[];
  private selectedIndex = 0;
  private maxVisible: number;
  private theme: SearchableSelectListTheme;
  private searchInput: Input;
  private regexCache = new Map<string, RegExp>();
  // eslint-disable-next-line no-control-regex -- intentional: matching ANSI escape sequences
  private ansiRegex = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;
  onSelectionChange?: (item: SelectItem) => void;

  constructor(items: SelectItem[], maxVisible: number, theme: SearchableSelectListTheme) {
    this.items = items;
    this.filteredItems = items;
    this.maxVisible = maxVisible;
    this.theme = theme;
    this.searchInput = new Input();
  }

  private getCachedRegex(pattern: string): RegExp {
    let regex = this.regexCache.get(pattern);
    if (!regex) {
      regex = new RegExp(this.escapeRegex(pattern), "gi");
      this.regexCache.set(pattern, regex);
    }
    // Reset lastIndex to ensure consistent behavior (defensive)
    regex.lastIndex = 0;
    return regex;
  }

  private updateFilter() {
    const query = this.searchInput.getValue().trim();

    if (!query) {
      this.filteredItems = this.items;
    } else {
      this.filteredItems = this.smartFilter(query);
    }

    // Reset selection when filter changes
    this.selectedIndex = 0;
    this.notifySelectionChange();
  }

  /**
   * Smart filtering that prioritizes:
   * 1. Exact substring match in label (highest priority)
   * 2. Word-boundary prefix match in label
   * 3. Exact substring in description
   * 4. Fuzzy match (lowest priority)
   */
  private smartFilter(query: string): SelectItem[] {
    const q = query.toLowerCase();
    type ScoredItem = { item: SelectItem; tier: number; score: number };
    const scoredItems: ScoredItem[] = [];
    const fuzzyCandidates: SelectItem[] = [];

    for (const item of this.items) {
      const label = item.label.toLowerCase();
      const desc = (item.description ?? "").toLowerCase();

      // Tier 1: Exact substring in label
      const labelIndex = label.indexOf(q);
      if (labelIndex !== -1) {
        scoredItems.push({ item, tier: 0, score: labelIndex });
        continue;
      }
      // Tier 2: Word-boundary prefix in label
      const wordBoundaryIndex = findWordBoundaryIndex(label, q);
      if (wordBoundaryIndex !== null) {
        scoredItems.push({ item, tier: 1, score: wordBoundaryIndex });
        continue;
      }
      // Tier 3: Exact substring in description
      const descIndex = desc.indexOf(q);
      if (descIndex !== -1) {
        scoredItems.push({ item, tier: 2, score: descIndex });
        continue;
      }
      // Tier 4: Fuzzy match (score 300+)
      fuzzyCandidates.push(item);
    }

    scoredItems.sort(this.compareByScore);

    const preparedCandidates = prepareSearchItems(fuzzyCandidates);
    const fuzzyMatches = fuzzyFilterLower(preparedCandidates, q);

    return [...scoredItems.map((s) => s.item), ...fuzzyMatches];
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private compareByScore = (
    a: { item: SelectItem; tier: number; score: number },
    b: { item: SelectItem; tier: number; score: number },
  ) => {
    if (a.tier !== b.tier) {
      return a.tier - b.tier;
    }
    if (a.score !== b.score) {
      return a.score - b.score;
    }
    return this.getItemLabel(a.item).localeCompare(this.getItemLabel(b.item));
  };

  private getItemLabel(item: SelectItem): string {
    return item.label || item.value;
  }

  private splitAnsiParts(text: string): Array<{ text: string; isAnsi: boolean }> {
    const parts: Array<{ text: string; isAnsi: boolean }> = [];
    const ansiRegex = this.ansiRegex;
    ansiRegex.lastIndex = 0;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = ansiRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push({ text: text.slice(lastIndex, match.index), isAnsi: false });
      }
      parts.push({ text: match[0], isAnsi: true });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      parts.push({ text: text.slice(lastIndex), isAnsi: false });
    }
    return parts;
  }

  private highlightMatch(text: string, query: string): string {
    const tokens = query
      .trim()
      .split(/\s+/)
      .map((token) => token.toLowerCase())
      .filter((token) => token.length > 0);
    if (tokens.length === 0) {
      return text;
    }

    const uniqueTokens = Array.from(new Set(tokens)).toSorted((a, b) => b.length - a.length);
    let parts = this.splitAnsiParts(text);

    for (const token of uniqueTokens) {
      // Skip ANSI escape sequences to avoid breaking color codes.
      const regex = this.getCachedRegex(token);
      const nextParts: Array<{ text: string; isAnsi: boolean }> = [];

      for (const part of parts) {
        if (part.isAnsi) {
          nextParts.push(part);
          continue;
        }

        regex.lastIndex = 0;
        const replaced = part.text.replace(regex, (m) => this.theme.matchHighlight(m));
        if (replaced === part.text) {
          nextParts.push(part);
          continue;
        }

        // Re-split only modified segments so new ANSI highlights are treated as ANSI.
        nextParts.push(...this.splitAnsiParts(replaced));
      }

      parts = nextParts;
    }

    return parts.map((part) => part.text).join("");
  }

  setSelectedIndex(index: number) {
    this.selectedIndex = Math.max(0, Math.min(index, this.filteredItems.length - 1));
  }

  invalidate() {
    this.searchInput.invalidate();
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // Search input line
    const promptText = "search: ";
    const prompt = this.theme.searchPrompt(promptText);
    const inputWidth = Math.max(1, width - visibleWidth(prompt));
    const inputLines = this.searchInput.render(inputWidth);
    const inputText = inputLines[0] ?? "";
    lines.push(`${prompt}${this.theme.searchInput(inputText)}`);
    lines.push(""); // Spacer

    const query = this.searchInput.getValue().trim();

    // If no items match filter, show message
    if (this.filteredItems.length === 0) {
      lines.push(this.theme.noMatch("  No matches"));
      return lines;
    }

    // Calculate visible range with scrolling
    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(this.maxVisible / 2),
        this.filteredItems.length - this.maxVisible,
      ),
    );
    const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);

    // Render visible items
    for (let i = startIndex; i < endIndex; i++) {
      const item = this.filteredItems[i];
      if (!item) {
        continue;
      }
      const isSelected = i === this.selectedIndex;
      lines.push(this.renderItemLine(item, isSelected, width, query));
    }

    // Show scroll indicator if needed
    if (this.filteredItems.length > this.maxVisible) {
      const scrollInfo = `${this.selectedIndex + 1}/${this.filteredItems.length}`;
      lines.push(this.theme.scrollInfo(`  ${scrollInfo}`));
    }

    return lines;
  }

  private renderItemLine(
    item: SelectItem,
    isSelected: boolean,
    width: number,
    query: string,
  ): string {
    const prefix = isSelected ? "→ " : "  ";
    const prefixWidth = prefix.length;
    const displayValue = this.getItemLabel(item);
    const truncatedLabel = truncateToWidth(displayValue, width - prefixWidth);

    const highlighted = query ? this.highlightMatch(truncatedLabel, query) : truncatedLabel;
    const line = `${prefix}${highlighted}`;

    return this.ensureLineWidth(isSelected ? this.theme.selected(line) : line, width);
  }

  private ensureLineWidth(text: string, width: number): string {
    const currentWidth = visibleWidth(text);

    if (currentWidth <= width) {
      return text;
    }

    return truncateToWidth(text, width);
  }

  handleKey(key: string): boolean {
    // Handle search input updates
    if (this.searchInput.handleKey(key)) {
      this.updateFilter();
      return true;
    }

    // Handle list navigation
    const editorKeys = getEditorKeybindings();

    if (matchesKey(key, editorKeys.up) || matchesKey(key, "up")) {
      if (!isKeyRelease(key)) {
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        this.notifySelectionChange();
      }
      return true;
    }

    if (matchesKey(key, editorKeys.down) || matchesKey(key, "down")) {
      if (!isKeyRelease(key)) {
        this.selectedIndex = Math.min(this.filteredItems.length - 1, this.selectedIndex + 1);
        this.notifySelectionChange();
      }
      return true;
    }

    if (matchesKey(key, editorKeys.enter) || matchesKey(key, "enter")) {
      if (!isKeyRelease(key)) {
        const item = this.filteredItems[this.selectedIndex];
        if (item) {
          this.onSelect?.(item);
        }
      }
      return true;
    }

    if (matchesKey(key, editorKeys.escape) || matchesKey(key, "escape")) {
      if (!isKeyRelease(key)) {
        this.onCancel?.();
      }
      return true;
    }

    return false;
  }

  private notifySelectionChange() {
    const item = this.filteredItems[this.selectedIndex];
    if (item) {
      this.onSelectionChange?.(item);
    }
  }
}
