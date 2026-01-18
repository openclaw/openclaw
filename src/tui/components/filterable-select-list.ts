import {
  Input,
  type SelectItem,
  SelectList,
  type SelectListTheme,
  fuzzyFilter,
} from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";
import chalk from "chalk";

export interface FilterableSelectItem extends SelectItem {
  /** Additional searchable fields beyond label */
  searchText?: string;
}

export interface FilterableSelectListTheme extends SelectListTheme {
  filterLabel: (text: string) => string;
  filterInput: (text: string) => string;
}

/**
 * Combines text input filtering with a select list.
 * User types to filter, arrows/j/k to navigate, Enter to select, Escape to clear/cancel.
 */
export class FilterableSelectList implements Component {
  private input: Input;
  private selectList: SelectList;
  private allItems: FilterableSelectItem[];
  private theme: FilterableSelectListTheme;
  private filterText = "";

  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;

  constructor(
    items: FilterableSelectItem[],
    maxVisible: number,
    theme: FilterableSelectListTheme,
  ) {
    this.allItems = items;
    this.theme = theme;

    this.input = new Input();
    this.selectList = new SelectList(items, maxVisible, theme);

    // Wire up input to filter the list
    this.input.onSubmit = () => {
      const selected = this.selectList.getSelectedItem();
      if (selected) {
        this.onSelect?.(selected);
      }
    };

    this.input.onEscape = () => {
      if (this.filterText) {
        // First escape clears filter
        this.filterText = "";
        this.input.setValue("");
        this.selectList.setFilter("");
        this.selectList.setSelectedIndex(0);
      } else {
        // Second escape cancels
        this.onCancel?.();
      }
    };
  }

  private getSearchText(item: FilterableSelectItem): string {
    const parts = [item.label];
    if (item.description) parts.push(item.description);
    if (item.searchText) parts.push(item.searchText);
    return parts.join(" ");
  }

  private applyFilter(): void {
    const query = this.filterText.toLowerCase().trim();
    if (!query) {
      // Reset to all items
      this.selectList = new SelectList(
        this.allItems,
        this.selectList["maxVisible"],
        this.theme,
      );
      this.selectList.onSelect = this.onSelect;
      this.selectList.onCancel = this.onCancel;
      return;
    }

    // Use fuzzy filter from pi-tui
    const filtered = fuzzyFilter(this.allItems, query, (item) =>
      this.getSearchText(item),
    );

    this.selectList = new SelectList(
      filtered,
      this.selectList["maxVisible"],
      this.theme,
    );
    this.selectList.onSelect = this.onSelect;
    this.selectList.onCancel = this.onCancel;
  }

  invalidate(): void {
    this.input.invalidate();
    this.selectList.invalidate();
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // Filter input row
    const filterLabel = this.theme.filterLabel("Filter: ");
    const inputLines = this.input.render(width - 8);
    const inputText = inputLines[0] ?? "";
    lines.push(filterLabel + inputText);

    // Separator
    lines.push(chalk.dim("─".repeat(width)));

    // Select list
    const listLines = this.selectList.render(width);
    lines.push(...listLines);

    return lines;
  }

  handleInput(keyData: string): void {
    // Navigation keys go to select list
    if (keyData === "\x1b[A" || keyData === "\x1b[B" || keyData === "k" || keyData === "j") {
      // Map vim keys to arrows for selectList
      if (keyData === "k") keyData = "\x1b[A";
      if (keyData === "j") keyData = "\x1b[B";
      this.selectList.handleInput(keyData);
      return;
    }

    // Enter selects
    if (keyData === "\r" || keyData === "\n") {
      const selected = this.selectList.getSelectedItem();
      if (selected) {
        this.onSelect?.(selected);
      }
      return;
    }

    // Escape: clear filter or cancel
    if (keyData === "\x1b" || keyData === "\x1b\x1b") {
      if (this.filterText) {
        this.filterText = "";
        this.input.setValue("");
        this.applyFilter();
      } else {
        this.onCancel?.();
      }
      return;
    }

    // All other input goes to filter
    const prevValue = this.input.getValue();
    this.input.handleInput(keyData);
    const newValue = this.input.getValue();

    if (newValue !== prevValue) {
      this.filterText = newValue;
      this.applyFilter();
    }
  }

  getSelectedItem(): SelectItem | null {
    return this.selectList.getSelectedItem();
  }

  getFilterText(): string {
    return this.filterText;
  }
}
