import {
  type Component,
  fuzzyFilter,
  Input,
  isKeyRelease,
  matchesKey,
  type SelectItem,
  type SelectListTheme,
  truncateToWidth,
} from "@mariozechner/pi-tui";

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
   * 3. Exact substring match in description
   * 4. Fuzzy match (lowest priority)
   */
  private smartFilter(query: string): SelectItem[] {
    const q = query.toLowerCase();
    type ScoredItem = { item: SelectItem; score: number };
    const exactLabel: ScoredItem[] = [];
    const wordBoundary: SelectItem[] = [];
    const descriptionMatches: SelectItem[] = [];
    const fuzzyCandidates: SelectItem[] = [];

    for (const item of this.items) {
      const label = item.label.toLowerCase();
      const desc = (item.description ?? "").toLowerCase();

      // Tier 1: Exact substring in label (score 0-99)
      const labelIndex = label.indexOf(q);
      if (labelIndex !== -1) {
        // Earlier match = better score
        exactLabel.push({ item, score: labelIndex });
        continue;
      }
      // Tier 2: Word-boundary prefix in label (score 100-199)
      if (this.matchesWordBoundary(label, q)) {
        wordBoundary.push(item);
        continue;
      }
      // Tier 3: Exact substring in description (score 200-299)
      if (desc.indexOf(q) !== -1) {
        descriptionMatches.push(item);
        continue;
      }
      // Tier 4: Fuzzy match (score 300+)
      fuzzyCandidates.push(item);
    }

    exactLabel.sort((a, b) => a.score - b.score);
    const fuzzyMatches = fuzzyFilter(fuzzyCandidates, query, (i) => `${i.label} ${i.description ?? ""}`);
    return [
      ...exactLabel.map((s) => s.item),
      ...wordBoundary,
      ...descriptionMatches,
      ...fuzzyMatches,
    ];
  }

  /**
   * Check if query matches at a word boundary in text.
   * E.g., "gpt" matches "openai/gpt-4" at the "gpt" word boundary.
   */
  private matchesWordBoundary(text: string, query: string): boolean {
    const wordBoundaryRegex = new RegExp(`(?:^|[\\s\\-_./:])(${this.escapeRegex(query)})`, "i");
    return wordBoundaryRegex.test(text);
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    const prompt = this.theme.searchPrompt("search: ");
    const inputWidth = Math.max(1, width - 8);
    const inputLines = this.searchInput.render(inputWidth);
    const inputText = inputLines[0] ?? "";
    lines.push(`${prompt}${this.theme.searchInput(inputText)}`);
    lines.push(""); // Spacer

    // If no items match filter, show message
    if (this.filteredItems.length === 0) {
      lines.push(this.theme.noMatch("  No matching models"));
      return lines;
    }

    // Calculate visible range with scrolling
    const startIndex = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
    );
    const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);

    // Render visible items
    for (let i = startIndex; i < endIndex; i++) {
      const item = this.filteredItems[i];
      if (!item) continue;
      const isSelected = i === this.selectedIndex;
      let line = "";

      if (isSelected) {
        const prefixWidth = 2;
        const displayValue = item.label || item.value;
        if (item.description && width > 40) {
          const maxValueWidth = Math.min(30, width - prefixWidth - 4);
          const truncatedValue = truncateToWidth(displayValue, maxValueWidth, "");
          const spacing = " ".repeat(Math.max(1, 32 - truncatedValue.length));
          const descriptionStart = prefixWidth + truncatedValue.length + spacing.length;
          const remainingWidth = width - descriptionStart - 2;
          if (remainingWidth > 10) {
            const truncatedDesc = truncateToWidth(item.description, remainingWidth, "");
            line = this.theme.selectedText(`→ ${truncatedValue}${spacing}${truncatedDesc}`);
          } else {
            const maxWidth = width - prefixWidth - 2;
            line = this.theme.selectedText(`→ ${truncateToWidth(displayValue, maxWidth, "")}`);
          }
        } else {
          const maxWidth = width - prefixWidth - 2;
          line = this.theme.selectedText(`→ ${truncateToWidth(displayValue, maxWidth, "")}`);
        }
      } else {
        const displayValue = item.label || item.value;
        const prefix = "  ";
        if (item.description && width > 40) {
          const maxValueWidth = Math.min(30, width - prefix.length - 4);
          const truncatedValue = truncateToWidth(displayValue, maxValueWidth, "");
          const spacing = " ".repeat(Math.max(1, 32 - truncatedValue.length));
          const descriptionStart = prefix.length + truncatedValue.length + spacing.length;
          const remainingWidth = width - descriptionStart - 2;
          if (remainingWidth > 10) {
            const truncatedDesc = truncateToWidth(item.description, remainingWidth, "");
            line = `${prefix}${truncatedValue}${spacing}${this.theme.description(truncatedDesc)}`;
          } else {
            const maxWidth = width - prefix.length - 2;
            line = `${prefix}${truncateToWidth(displayValue, maxWidth, "")}`;
          }
        } else {
          const maxWidth = width - prefix.length - 2;
          line = `${prefix}${truncateToWidth(displayValue, maxWidth, "")}`;
        }
      }
      lines.push(line);
    }

    // Show scroll indicator if needed
    if (this.filteredItems.length > this.maxVisible) {
      const scrollInfo = `${this.selectedIndex + 1}/${this.filteredItems.length}`;
      lines.push(this.theme.scrollInfo(`  ${scrollInfo}`));
    }

    return lines;
  }

  handleInput(keyData: string): void {
    if (isKeyRelease(keyData)) return;

    // Navigation keys
    if (matchesKey(keyData, "up") || matchesKey(keyData, "ctrl+p")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.notifySelectionChange();
      return;
    }

    if (matchesKey(keyData, "down") || matchesKey(keyData, "ctrl+n")) {
      this.selectedIndex = Math.min(this.filteredItems.length - 1, this.selectedIndex + 1);
      this.notifySelectionChange();
      return;
    }

    if (matchesKey(keyData, "enter")) {
      const item = this.filteredItems[this.selectedIndex];
      if (item && this.onSelect) {
        this.onSelect(item);
      }
      return;
    }

    if (matchesKey(keyData, "escape")) {
      if (this.onCancel) {
        this.onCancel();
      }
      return;
    }

    // Pass other keys to search input
    const prevValue = this.searchInput.getValue();
    this.searchInput.handleInput(keyData);
    const newValue = this.searchInput.getValue();

    if (prevValue !== newValue) {
      this.updateFilter();
    }
  }

  private notifySelectionChange() {
    const item = this.filteredItems[this.selectedIndex];
    if (item && this.onSelectionChange) {
      this.onSelectionChange(item);
    }
  }

  getSelectedItem(): SelectItem | null {
    return this.filteredItems[this.selectedIndex] ?? null;
  }
}
