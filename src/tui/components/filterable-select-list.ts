import {
  type Component,
  type Focusable,
  fuzzyFilter,
  matchesKey,
  type SelectItem,
  SelectList,
  type SelectListTheme,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import { sanitizeRenderableLine } from "../tui-formatters.js";
import { SelectListInput } from "./select-list-input.js";

export interface FilterableSelectItem extends SelectItem {
  /** Additional searchable fields beyond label */
  searchText?: string;
}

interface FilterableSelectListTheme extends SelectListTheme {
  filterLabel: (text: string) => string;
}

/**
 * Combines text input filtering with a select list.
 * User types to filter, arrows or Ctrl+P/Ctrl+N navigate, and Escape clears or cancels.
 */
export class FilterableSelectList extends SelectListInput implements Component, Focusable {
  private selectList: SelectList;
  private allItems: Array<{ item: FilterableSelectItem; searchText: string }>;

  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;

  constructor(
    items: FilterableSelectItem[],
    private readonly maxVisible: number,
    private readonly theme: FilterableSelectListTheme,
  ) {
    super();
    // Each overlay owns fixed rows; search keeps raw fields while display copies stay sanitized.
    this.allItems = items.map((item) => ({
      searchText: [item.label, item.description, item.searchText].filter(Boolean).join(" "),
      item: {
        ...item,
        label:
          sanitizeRenderableLine(item.label || item.value) ||
          sanitizeRenderableLine(item.value) ||
          "(unnamed)",
        description: sanitizeRenderableLine(item.description ?? ""),
      },
    }));
    // Input owns terminal key decoding; clearing follows the normal filter refresh.
    this.input.onEscape = () => {
      if (this.input.getValue()) {
        this.input.setValue("");
      } else {
        this.onCancel?.();
      }
    };
    this.selectList = this.createSelectList(this.allItems);
  }

  private createSelectList(items: typeof this.allItems): SelectList {
    return new SelectList(
      items.map((entry) => entry.item),
      this.maxVisible,
      this.theme,
    );
  }

  override invalidate(): void {
    super.invalidate();
    this.selectList.invalidate();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const safeWidth = Math.max(0, width);

    lines.push(this.renderInput(safeWidth, this.theme.filterLabel("Filter: ")));

    lines.push(chalk.dim("─".repeat(safeWidth)));

    const listLines = this.selectList.render(safeWidth);
    lines.push(...listLines.map((line) => truncateToWidth(line, safeWidth, "")));

    return lines;
  }

  handleInput(keyData: string): void {
    // Printable keys must reach the filter; arrows and Ctrl keys own navigation.
    if (matchesKey(keyData, "up") || matchesKey(keyData, "ctrl+p")) {
      this.selectList.handleInput("\x1b[A");
      return;
    }

    if (matchesKey(keyData, "down") || matchesKey(keyData, "ctrl+n")) {
      this.selectList.handleInput("\x1b[B");
      return;
    }

    if (matchesKey(keyData, "enter")) {
      const selected = this.selectList.getSelectedItem();
      if (selected) {
        this.onSelect?.(selected);
      }
      return;
    }

    if (this.updateInput(keyData)) {
      this.selectList = this.createSelectList(
        fuzzyFilter(this.allItems, this.input.getValue(), (entry) => entry.searchText),
      );
    }
  }
}
