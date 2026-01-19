import {
	Input,
	matchesKey,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	getEditorKeybindings,
} from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";
import chalk from "chalk";

/**
 * Fuzzy match with pre-lowercased inputs (avoids toLowerCase on every keystroke).
 * Returns score (lower = better) or null if no match.
 */
function fuzzyMatchLower(queryLower: string, textLower: string): number | null {
	if (queryLower.length === 0) return 0;
	if (queryLower.length > textLower.length) return null;

	let queryIndex = 0;
	let score = 0;
	let lastMatchIndex = -1;
	let consecutiveMatches = 0;

	for (let i = 0; i < textLower.length && queryIndex < queryLower.length; i++) {
		if (textLower[i] === queryLower[queryIndex]) {
			const isWordBoundary = i === 0 || /[\s\-_./:]/.test(textLower[i - 1]);
			if (lastMatchIndex === i - 1) {
				consecutiveMatches++;
				score -= consecutiveMatches * 5;
			} else {
				consecutiveMatches = 0;
				if (lastMatchIndex >= 0) score += (i - lastMatchIndex - 1) * 2;
			}
			if (isWordBoundary) score -= 10;
			score += i * 0.1;
			lastMatchIndex = i;
			queryIndex++;
		}
	}
	return queryIndex < queryLower.length ? null : score;
}

/**
 * Filter items using pre-lowercased searchTextLower field.
 * Supports space-separated tokens (all must match).
 */
function fuzzyFilterLower<T extends { searchTextLower?: string }>(
	items: T[],
	queryLower: string,
): T[] {
	const trimmed = queryLower.trim();
	if (!trimmed) return items;

	const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);
	if (tokens.length === 0) return items;

	const results: { item: T; score: number }[] = [];
	for (const item of items) {
		const text = item.searchTextLower ?? "";
		let totalScore = 0;
		let allMatch = true;
		for (const token of tokens) {
			const score = fuzzyMatchLower(token, text);
			if (score !== null) {
				totalScore += score;
			} else {
				allMatch = false;
				break;
			}
		}
		if (allMatch) results.push({ item, score: totalScore });
	}
	results.sort((a, b) => a.score - b.score);
	return results.map((r) => r.item);
}

export interface FilterableSelectItem extends SelectItem {
	/** Additional searchable fields beyond label */
	searchText?: string;
	/** Pre-computed lowercase search text (label + description + searchText) for filtering */
	searchTextLower?: string;
}

export interface FilterableSelectListTheme extends SelectListTheme {
	filterLabel: (text: string) => string;
}

/**
 * Combines text input filtering with a select list.
 * User types to filter, arrows/j/k to navigate, Enter to select, Escape to clear/cancel.
 */
export class FilterableSelectList implements Component {
	private input: Input;
	private selectList: SelectList;
	private allItems: FilterableSelectItem[];
	private maxVisible: number;
	private theme: FilterableSelectListTheme;
	private filterText = "";

	onSelect?: (item: SelectItem) => void;
	onCancel?: () => void;

	constructor(items: FilterableSelectItem[], maxVisible: number, theme: FilterableSelectListTheme) {
		// Pre-compute searchTextLower for each item once
		this.allItems = items.map((item) => {
			if (item.searchTextLower) return item;
			const parts = [item.label];
			if (item.description) parts.push(item.description);
			if (item.searchText) parts.push(item.searchText);
			return { ...item, searchTextLower: parts.join(" ").toLowerCase() };
		});
		this.maxVisible = maxVisible;
		this.theme = theme;

		this.input = new Input();
		this.selectList = new SelectList(this.allItems, maxVisible, theme);
	}

	private applyFilter(): void {
		const queryLower = this.filterText.toLowerCase();
		if (!queryLower.trim()) {
			this.selectList = new SelectList(this.allItems, this.maxVisible, this.theme);
			return;
		}
		const filtered = fuzzyFilterLower(this.allItems, queryLower);
		this.selectList = new SelectList(filtered, this.maxVisible, this.theme);
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
		// Navigation: arrows, vim j/k, or ctrl+p/ctrl+n
		if (matchesKey(keyData, "up") || matchesKey(keyData, "ctrl+p") || keyData === "k") {
			this.selectList.handleInput("\x1b[A");
			return;
		}

		if (matchesKey(keyData, "down") || matchesKey(keyData, "ctrl+n") || keyData === "j") {
			this.selectList.handleInput("\x1b[B");
			return;
		}

		// Enter selects
		if (matchesKey(keyData, "enter")) {
			const selected = this.selectList.getSelectedItem();
			if (selected) {
				this.onSelect?.(selected);
			}
			return;
		}

		// Escape: clear filter or cancel
		const kb = getEditorKeybindings();
		if (kb.matches(keyData, "selectCancel")) {
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
