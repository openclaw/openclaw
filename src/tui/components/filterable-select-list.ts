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
import { stableWindowStart } from "./list-window.js";
import { SelectListInput } from "./select-list-input.js";

export interface FilterableSelectItem extends SelectItem {
  /** Additional searchable fields beyond label */
  searchText?: string;
}

interface FilterableSelectListTheme extends SelectListTheme {
  filterLabel: (text: string) => string;
}

/**
 * User types to filter, arrows or Ctrl+P/Ctrl+N navigate, and Escape clears or cancels.
 */
export class FilterableSelectList extends SelectListInput implements Component, Focusable {
  private visibleEntries: Array<{ item: FilterableSelectItem; searchText: string }>;
  private selectedIndex = 0;
  private windowStart?: number;
  /**
   * Screen reader mode: the window moves only when the selection leaves it, and the divider and
   * position counter are left out because a reader would announce them on every repaint.
   */
  stableWindow = false;
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
    this.visibleEntries = this.allItems;
  }

  // pi-tui's SelectList wraps at both ends; keep that.
  private wrapIndex(index: number) {
    const count = this.visibleEntries.length;
    return count === 0 ? 0 : (index + count) % count;
  }

  private selectedEntry() {
    return this.visibleEntries[this.selectedIndex]?.item ?? null;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    const total = this.visibleEntries.length;
    let list: SelectList;
    let start = 0;
    if (this.stableWindow) {
      start = stableWindowStart(this.windowStart, this.selectedIndex, total, this.maxVisible);
      this.windowStart = start;
      const rows = this.visibleEntries.slice(start, start + this.maxVisible).map((e) => e.item);
      // pi-tui's own window re-centers on every arrow press, so it only ever sees this slice.
      list = new SelectList(rows, Math.max(1, rows.length), this.theme);
    } else {
      list = new SelectList(
        this.visibleEntries.map((e) => e.item),
        this.maxVisible,
        this.theme,
      );
    }
    list.setSelectedIndex(this.selectedIndex - start);
    const lines = list.render(safeWidth);
    return [
      this.renderInput(safeWidth, this.theme.filterLabel("Filter: ")),
      ...(this.stableWindow ? [] : [chalk.dim("─".repeat(safeWidth))]),
      ...lines.map((line) => truncateToWidth(line, safeWidth, "")),
    ];
  }

  handleInput(keyData: string): void {
    // Printable keys must reach the filter; arrows and Ctrl keys own navigation.
    if (matchesKey(keyData, "up") || matchesKey(keyData, "ctrl+p")) {
      this.selectedIndex = this.wrapIndex(this.selectedIndex - 1);
      return;
    }

    if (matchesKey(keyData, "down") || matchesKey(keyData, "ctrl+n")) {
      this.selectedIndex = this.wrapIndex(this.selectedIndex + 1);
      return;
    }

    if (matchesKey(keyData, "enter")) {
      const selected = this.selectedEntry();
      if (selected) {
        this.onSelect?.(selected);
      }
      return;
    }

    if (this.updateInput(keyData)) {
      this.visibleEntries = fuzzyFilter(
        this.allItems,
        this.input.getValue(),
        (entry) => entry.searchText,
      );
      this.selectedIndex = 0;
      this.windowStart = undefined;
    }
  }
}
