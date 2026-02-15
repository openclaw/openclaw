import chalk from "chalk";
/**
 * Standalone FZF-like searchable select for CLI prompts.
 * Reuses fuzzy filtering logic but handles terminal I/O directly.
 */
import { stdin, stdout } from "node:process";
import { stripAnsi } from "../terminal/ansi.js";
import { findWordBoundaryIndex, fuzzyFilterLower } from "../tui/components/fuzzy-filter.js";

export interface SearchableSelectItem<T = string> {
  value: T;
  label: string;
  hint?: string;
}

export interface SearchableSelectParams<T = string> {
  message: string;
  options: SearchableSelectItem<T>[];
  initialValue?: T;
  maxVisible?: number;
}

interface FilteredItem<T> {
  item: SearchableSelectItem<T>;
  searchTextLower: string;
}

const ANSI = {
  clearLine: "\x1b[2K",
  cursorUp: (n: number) => `\x1b[${n}A`,
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
};

/**
 * Smart filtering that prioritizes:
 * 1. Exact substring match in label (highest priority)
 * 2. Word-boundary prefix match in label
 * 3. Exact substring in hint
 * 4. Fuzzy match (lowest priority)
 */
function smartFilter<T>(items: FilteredItem<T>[], query: string): FilteredItem<T>[] {
  const q = query.toLowerCase();
  type ScoredItem = { item: FilteredItem<T>; tier: number; score: number };
  const scoredItems: ScoredItem[] = [];
  const fuzzyCandidates: FilteredItem<T>[] = [];

  for (const entry of items) {
    const label = entry.item.label.toLowerCase();
    const hint = (entry.item.hint ?? "").toLowerCase();

    // Tier 1: Exact substring in label
    const labelIndex = label.indexOf(q);
    if (labelIndex !== -1) {
      scoredItems.push({ item: entry, tier: 0, score: labelIndex });
      continue;
    }
    // Tier 2: Word-boundary prefix in label
    const wordBoundaryIndex = findWordBoundaryIndex(label, q);
    if (wordBoundaryIndex !== null) {
      scoredItems.push({ item: entry, tier: 1, score: wordBoundaryIndex });
      continue;
    }
    // Tier 3: Exact substring in hint
    const hintIndex = hint.indexOf(q);
    if (hintIndex !== -1) {
      scoredItems.push({ item: entry, tier: 2, score: hintIndex });
      continue;
    }
    // Tier 4: Fuzzy match
    fuzzyCandidates.push(entry);
  }

  scoredItems.sort((a, b) => {
    if (a.tier !== b.tier) {
      return a.tier - b.tier;
    }
    if (a.score !== b.score) {
      return a.score - b.score;
    }
    return a.item.item.label.localeCompare(b.item.item.label);
  });

  const fuzzyMatches = fuzzyFilterLower(fuzzyCandidates, q);
  return [...scoredItems.map((s) => s.item), ...fuzzyMatches];
}

function highlightMatches(text: string, query: string): string {
  if (!query.trim()) {
    return text;
  }
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return text;
  }

  // Sort by length descending to match longer tokens first
  const sortedTokens = [...new Set(tokens)].toSorted((a, b) => b.length - a.length);
  let result = text;
  for (const token of sortedTokens) {
    const regex = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    result = result.replace(regex, (match) => chalk.cyan.underline(match));
  }
  return result;
}

function truncateToWidth(text: string, maxWidth: number): string {
  const stripped = stripAnsi(text);
  if (stripped.length <= maxWidth) {
    return text;
  }
  // Simple truncation - could be improved to handle ANSI properly
  return stripped.slice(0, maxWidth - 1) + "…";
}

export async function searchableSelect<T>(params: SearchableSelectParams<T>): Promise<T> {
  // Handle empty options
  if (params.options.length === 0) {
    return Promise.reject(new Error("No options provided"));
  }

  // Check if we're in a TTY environment
  if (!stdin.isTTY) {
    // Fall back to returning the first option or initialValue
    const fallback = params.initialValue ?? params.options[0]?.value;
    if (fallback !== undefined) {
      return Promise.resolve(fallback);
    }
    return Promise.reject(new Error("Non-interactive environment and no default value"));
  }

  const maxVisible = params.maxVisible ?? 10;
  const termWidth = stdout.columns || 80;
  const maxSearchDisplay = Math.max(20, termWidth - 10);

  // Prepare items for fuzzy filtering
  const allItems: FilteredItem<T>[] = params.options.map((item) => ({
    item,
    searchTextLower: `${item.label} ${item.hint ?? ""}`.toLowerCase(),
  }));

  let searchText = "";
  let selectedIndex = 0;
  let filteredItems = allItems;

  // Find initial selection
  if (params.initialValue !== undefined) {
    const idx = allItems.findIndex((i) => i.item.value === params.initialValue);
    if (idx !== -1) {
      selectedIndex = idx;
    }
  }

  // Update filtered items based on search text
  const updateFilter = () => {
    if (searchText.trim()) {
      filteredItems = smartFilter(allItems, searchText);
    } else {
      filteredItems = allItems;
    }
    // Clamp selection to valid range
    if (filteredItems.length === 0) {
      selectedIndex = 0;
    } else if (selectedIndex >= filteredItems.length) {
      selectedIndex = filteredItems.length - 1;
    }
  };

  let lastRenderedLines = 0;

  const render = () => {
    const lines: string[] = [];

    // Message/prompt line (matches clack's gray bar style)
    lines.push(chalk.gray("│"));
    lines.push(`${chalk.cyan("◇")}  ${chalk.bold(params.message)}`);
    lines.push(chalk.gray("│"));

    // Search input line (truncate if too long)
    const searchPrompt = chalk.gray("│  ");
    const displayText =
      searchText.length > maxSearchDisplay
        ? "…" + searchText.slice(-(maxSearchDisplay - 1))
        : searchText;
    const inputDisplay = displayText || chalk.dim("Type to search...");
    lines.push(`${searchPrompt}${inputDisplay}${chalk.cyan("█")}`);
    lines.push(chalk.gray("│"));

    if (filteredItems.length === 0) {
      lines.push(`${chalk.gray("│")}  ${chalk.dim("No matches")}`);
    } else {
      // Calculate visible range with scrolling
      const startIndex = Math.max(
        0,
        Math.min(selectedIndex - Math.floor(maxVisible / 2), filteredItems.length - maxVisible),
      );
      const endIndex = Math.min(startIndex + maxVisible, filteredItems.length);

      for (let i = startIndex; i < endIndex; i++) {
        const entry = filteredItems[i];
        if (!entry) {
          continue;
        }
        const isSelected = i === selectedIndex;
        const prefix = isSelected ? chalk.green("● ") : chalk.dim("○ ");

        let line = highlightMatches(entry.item.label, searchText);
        if (entry.item.hint) {
          const hintText = highlightMatches(entry.item.hint, searchText);
          line += chalk.dim(` · ${hintText}`);
        }

        const maxLineWidth = termWidth - 4;
        line = truncateToWidth(line, maxLineWidth);

        if (isSelected) {
          lines.push(`${chalk.gray("│")} ${prefix}${chalk.underline(line)}`);
        } else {
          lines.push(`${chalk.gray("│")} ${prefix}${line}`);
        }
      }

      // Scroll indicator
      if (filteredItems.length > maxVisible) {
        lines.push(
          `${chalk.gray("│")}  ${chalk.dim(`${selectedIndex + 1}/${filteredItems.length}`)}`,
        );
      }
    }

    // Bottom bar
    lines.push(chalk.gray("│"));

    // Clear previous output and render new
    if (lastRenderedLines > 0) {
      stdout.write(ANSI.cursorUp(lastRenderedLines));
    }
    for (const line of lines) {
      stdout.write(ANSI.clearLine + line + "\n");
    }
    // Clear any remaining lines from previous render
    for (let i = lines.length; i < lastRenderedLines; i++) {
      stdout.write(ANSI.clearLine + "\n");
    }
    if (lastRenderedLines > lines.length) {
      stdout.write(ANSI.cursorUp(lastRenderedLines - lines.length));
    }
    lastRenderedLines = lines.length;
  };

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.removeListener("data", onData);
      stdout.write(ANSI.showCursor);
    };

    const onData = (data: Buffer) => {
      const raw = data.toString();

      // Process each character/sequence in the buffer
      // This handles rapid typing where multiple chars arrive in one data event
      let i = 0;
      let needsRender = false;

      while (i < raw.length) {
        // Ctrl+C
        if (raw[i] === "\x03") {
          cleanup();
          reject(new Error("cancelled"));
          return;
        }

        // Escape sequences (arrows, etc.)
        if (raw[i] === "\x1b") {
          // Check for arrow keys and other escape sequences
          // Up arrow
          if (raw.slice(i, i + 3) === "\x1b[A") {
            selectedIndex = Math.max(0, selectedIndex - 1);
            needsRender = true;
            i += 3;
            continue;
          }
          // Down arrow
          if (raw.slice(i, i + 3) === "\x1b[B") {
            selectedIndex = Math.min(filteredItems.length - 1, selectedIndex + 1);
            needsRender = true;
            i += 3;
            continue;
          }
          // Page Up
          if (raw.slice(i, i + 4) === "\x1b[5~") {
            selectedIndex = Math.max(0, selectedIndex - maxVisible);
            needsRender = true;
            i += 4;
            continue;
          }
          // Page Down
          if (raw.slice(i, i + 4) === "\x1b[6~") {
            selectedIndex = Math.min(filteredItems.length - 1, selectedIndex + maxVisible);
            needsRender = true;
            i += 4;
            continue;
          }
          // Home
          if (raw.slice(i, i + 3) === "\x1b[H" || raw.slice(i, i + 4) === "\x1b[1~") {
            selectedIndex = 0;
            needsRender = true;
            i += raw.slice(i, i + 4) === "\x1b[1~" ? 4 : 3;
            continue;
          }
          // End
          if (raw.slice(i, i + 3) === "\x1b[F" || raw.slice(i, i + 4) === "\x1b[4~") {
            selectedIndex = Math.max(0, filteredItems.length - 1);
            needsRender = true;
            i += raw.slice(i, i + 4) === "\x1b[4~" ? 4 : 3;
            continue;
          }
          // Plain escape - cancel
          if (i === raw.length - 1 || raw[i + 1] !== "[") {
            cleanup();
            reject(new Error("cancelled"));
            return;
          }
          // Skip unknown escape sequence
          i++;
          continue;
        }

        // Ctrl+P (up)
        if (raw[i] === "\x10") {
          selectedIndex = Math.max(0, selectedIndex - 1);
          needsRender = true;
          i++;
          continue;
        }

        // Ctrl+N (down)
        if (raw[i] === "\x0e") {
          selectedIndex = Math.min(filteredItems.length - 1, selectedIndex + 1);
          needsRender = true;
          i++;
          continue;
        }

        // Enter
        if (raw[i] === "\r" || raw[i] === "\n") {
          if (filteredItems.length === 0) {
            // Don't submit when no matches, just continue
            i++;
            continue;
          }
          const selected = filteredItems[selectedIndex];
          if (selected) {
            cleanup();
            resolve(selected.item.value);
          }
          return;
        }

        // Backspace
        if (raw[i] === "\x7f" || raw[i] === "\b") {
          if (searchText.length > 0) {
            searchText = searchText.slice(0, -1);
            updateFilter();
            selectedIndex = 0; // Reset to top after filter change
            needsRender = true;
          }
          i++;
          continue;
        }

        // Ctrl+U - clear search
        if (raw[i] === "\x15") {
          searchText = "";
          updateFilter();
          selectedIndex = 0;
          needsRender = true;
          i++;
          continue;
        }

        // Regular character input
        const char = raw[i];
        if (char && char >= " " && char <= "~") {
          searchText += char;
          updateFilter();
          selectedIndex = 0; // Reset to top - best match is first
          needsRender = true;
        }
        i++;
      }

      if (needsRender) {
        render();
      }
    };

    // Setup terminal
    stdout.write(ANSI.hideCursor);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);

    // Initial render
    render();
  });
}
