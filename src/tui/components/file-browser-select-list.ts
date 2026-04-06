import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type Component,
  Input,
  Key,
  isKeyRelease,
  matchesKey,
  truncateToWidth,
} from "@mariozechner/pi-tui";
import { visibleWidth } from "../../terminal/ansi.js";

export interface FileBrowserTheme {
  selectedPrefix: (text: string) => string;
  selectedText: (text: string) => string;
  description: (text: string) => string;
  scrollInfo: (text: string) => string;
  noMatch: (text: string) => string;
  searchPrompt: (text: string) => string;
  searchInput: (text: string) => string;
  checked: (text: string) => string;
  unchecked: (text: string) => string;
  dirIcon: (text: string) => string;
  fileIcon: (text: string) => string;
  breadcrumb: (text: string) => string;
}

export interface FileEntry {
  name: string;
  fullPath: string;
  isDirectory: boolean;
}

/**
 * A file browser with multi-select checkboxes for picking files to upload as context.
 *
 * Controls:
 *   Up/Down  – navigate
 *   Space    – toggle file selection
 *   Enter    – open directory / confirm selection
 *   Backspace or Left – go to parent directory
 *   Esc      – cancel
 */
export class FileBrowserSelectList implements Component {
  private currentDir: string;
  private entries: FileEntry[] = [];
  private filteredEntries: FileEntry[] = [];
  private selectedIndex = 0;
  private maxVisible: number;
  private theme: FileBrowserTheme;
  private checkedPaths = new Set<string>();
  private searchInput: Input;

  onConfirm?: (paths: string[]) => void;
  onCancel?: () => void;

  constructor(initialDir: string, maxVisible: number, theme: FileBrowserTheme) {
    this.currentDir = resolve(initialDir);
    this.maxVisible = maxVisible;
    this.theme = theme;
    this.searchInput = new Input();
    this.loadEntries();
  }

  private loadEntries() {
    try {
      const names = readdirSync(this.currentDir);
      const dirs: FileEntry[] = [];
      const files: FileEntry[] = [];
      for (const name of names) {
        if (name.startsWith(".")) {
          continue;
        }
        const fullPath = join(this.currentDir, name);
        try {
          const stat = statSync(fullPath);
          const entry: FileEntry = { name, fullPath, isDirectory: stat.isDirectory() };
          if (stat.isDirectory()) {
            dirs.push(entry);
          } else {
            files.push(entry);
          }
        } catch {
          // Skip entries we can't stat (permissions, broken symlinks, etc.)
        }
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name));
      files.sort((a, b) => a.name.localeCompare(b.name));
      this.entries = [...dirs, ...files];
    } catch {
      this.entries = [];
    }
    this.applyFilter();
    this.selectedIndex = 0;
  }

  private applyFilter() {
    const query = this.searchInput.getValue().trim().toLowerCase();
    if (!query) {
      this.filteredEntries = this.entries;
    } else {
      this.filteredEntries = this.entries.filter((e) => e.name.toLowerCase().includes(query));
    }
  }

  private navigateTo(dir: string) {
    this.currentDir = resolve(dir);
    this.searchInput = new Input();
    this.loadEntries();
  }

  invalidate() {
    this.searchInput.invalidate();
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // Breadcrumb showing current directory
    const dirLabel = this.currentDir;
    const truncatedDir = truncateToWidth(dirLabel, Math.max(1, width - 4), "");
    lines.push(this.theme.breadcrumb(truncatedDir));

    // Selected count
    const count = this.checkedPaths.size;
    const countLabel =
      count > 0 ? `${count} file${count > 1 ? "s" : ""} selected` : "No files selected";
    lines.push(
      this.theme.description(
        `  ${countLabel}  (space: toggle, enter: open dir/confirm, esc: cancel)`,
      ),
    );
    lines.push("");

    // Search input
    const promptText = "filter: ";
    const prompt = this.theme.searchPrompt(promptText);
    const inputWidth = Math.max(1, width - visibleWidth(prompt));
    const inputLines = this.searchInput.render(inputWidth);
    lines.push(`${prompt}${this.theme.searchInput(inputLines[0] ?? "")}`);
    lines.push("");

    if (this.filteredEntries.length === 0) {
      lines.push(this.theme.noMatch("  No files found"));
      return lines;
    }

    // Calculate visible range with scrolling
    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(this.maxVisible / 2),
        this.filteredEntries.length - this.maxVisible,
      ),
    );
    const endIndex = Math.min(startIndex + this.maxVisible, this.filteredEntries.length);

    for (let i = startIndex; i < endIndex; i++) {
      const entry = this.filteredEntries[i];
      if (!entry) {
        continue;
      }
      const isSelected = i === this.selectedIndex;
      lines.push(this.renderEntry(entry, isSelected, width));
    }

    if (this.filteredEntries.length > this.maxVisible) {
      const scrollInfo = `${this.selectedIndex + 1}/${this.filteredEntries.length}`;
      lines.push(this.theme.scrollInfo(`  ${scrollInfo}`));
    }

    return lines;
  }

  private renderEntry(entry: FileEntry, isSelected: boolean, width: number): string {
    const cursor = isSelected ? "→ " : "  ";
    const checkbox = entry.isDirectory
      ? "  "
      : this.checkedPaths.has(entry.fullPath)
        ? this.theme.checked("[x] ")
        : this.theme.unchecked("[ ] ");
    const icon = entry.isDirectory ? this.theme.dirIcon("📁 ") : this.theme.fileIcon("  ");
    const suffix = entry.isDirectory ? "/" : "";
    const maxNameWidth = Math.max(
      1,
      width - visibleWidth(cursor) - visibleWidth(checkbox) - visibleWidth(icon) - 2,
    );
    const name = truncateToWidth(`${entry.name}${suffix}`, maxNameWidth, "");
    const line = `${cursor}${checkbox}${icon}${name}`;
    return isSelected ? this.theme.selectedText(line) : line;
  }

  handleInput(keyData: string): void {
    if (isKeyRelease(keyData)) {
      return;
    }

    // Navigation
    if (matchesKey(keyData, "up") || matchesKey(keyData, "ctrl+p")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(keyData, "down") || matchesKey(keyData, "ctrl+n")) {
      this.selectedIndex = Math.min(this.filteredEntries.length - 1, this.selectedIndex + 1);
      return;
    }

    // Space: toggle file selection
    if (keyData === " ") {
      const entry = this.filteredEntries[this.selectedIndex];
      if (entry && !entry.isDirectory) {
        if (this.checkedPaths.has(entry.fullPath)) {
          this.checkedPaths.delete(entry.fullPath);
        } else {
          this.checkedPaths.add(entry.fullPath);
        }
      }
      // If it's a directory, space navigates into it
      if (entry?.isDirectory) {
        this.navigateTo(entry.fullPath);
      }
      return;
    }

    // Enter: open directory or confirm selection
    if (matchesKey(keyData, "enter")) {
      const entry = this.filteredEntries[this.selectedIndex];
      if (entry?.isDirectory) {
        this.navigateTo(entry.fullPath);
        return;
      }
      // Confirm selection
      if (this.checkedPaths.size > 0) {
        this.onConfirm?.([...this.checkedPaths]);
      } else {
        // If no files checked but cursor is on a file, select that one
        if (entry && !entry.isDirectory) {
          this.onConfirm?.([entry.fullPath]);
        }
      }
      return;
    }

    // Backspace when filter is empty, or Left arrow: go to parent
    if (
      matchesKey(keyData, "left") ||
      (matchesKey(keyData, "backspace") && !this.searchInput.getValue())
    ) {
      const parent = resolve(this.currentDir, "..");
      if (parent !== this.currentDir) {
        this.navigateTo(parent);
      }
      return;
    }

    // Escape: cancel
    if (matchesKey(keyData, Key.escape) || matchesKey(keyData, Key.ctrl("c"))) {
      this.onCancel?.();
      return;
    }

    // Pass other keys to search/filter input
    const prevValue = this.searchInput.getValue();
    this.searchInput.handleInput(keyData);
    if (prevValue !== this.searchInput.getValue()) {
      this.applyFilter();
      this.selectedIndex = 0;
    }
  }

  getSelectedPaths(): string[] {
    return [...this.checkedPaths];
  }
}
