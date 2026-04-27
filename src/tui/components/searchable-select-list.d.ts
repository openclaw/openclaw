import { type Component, type SelectItem, type SelectListTheme } from "@mariozechner/pi-tui";
export interface SearchableSelectListTheme extends SelectListTheme {
    searchPrompt: (text: string) => string;
    searchInput: (text: string) => string;
    matchHighlight: (text: string) => string;
}
/**
 * A select list with a search input at the top for fuzzy filtering.
 */
export declare class SearchableSelectList implements Component {
    private items;
    private filteredItems;
    private selectedIndex;
    private maxVisible;
    private theme;
    private searchInput;
    private regexCache;
    onSelect?: (item: SelectItem) => void;
    onCancel?: () => void;
    onSelectionChange?: (item: SelectItem) => void;
    private static readonly DESCRIPTION_LAYOUT_MIN_WIDTH;
    private static readonly DESCRIPTION_MIN_WIDTH;
    private static readonly DESCRIPTION_SPACING_WIDTH;
    private static readonly RIGHT_MARGIN_WIDTH;
    constructor(items: SelectItem[], maxVisible: number, theme: SearchableSelectListTheme);
    private getCachedRegex;
    private updateFilter;
    /**
     * Smart filtering that prioritizes:
     * 1. Exact substring match in label (highest priority)
     * 2. Word-boundary prefix match in label
     * 3. Exact substring in description
     * 4. Fuzzy match (lowest priority)
     */
    private smartFilter;
    private escapeRegex;
    private compareByScore;
    private getItemLabel;
    private splitAnsiParts;
    private highlightMatch;
    setSelectedIndex(index: number): void;
    invalidate(): void;
    render(width: number): string[];
    private renderItemLine;
    private getDescriptionLayout;
    handleInput(keyData: string): void;
    private notifySelectionChange;
    getSelectedItem(): SelectItem | null;
}
