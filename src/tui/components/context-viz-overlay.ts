import type { Component } from "@mariozechner/pi-tui";
import { isKeyRelease, matchesKey } from "@mariozechner/pi-tui";
import chalk from "chalk";
import type { SessionSystemPromptReport } from "../../config/sessions/types.js";
import { palette, theme } from "../theme/theme.js";
import {
  getCategoryColor,
  renderCategoryBar,
  renderHorizontalBar,
  renderProportionalBar,
  renderSparkline,
} from "./context-viz-bars.js";
import {
  type CategoryBreakdown,
  type CategoryDetailItem,
  type ContextHistory,
  type SessionTokenInfo,
  createHistory,
  formatCharsAndTokens,
  formatInt,
  getCategoryBreakdown,
  getCategoryDetail,
  getTotalChars,
  pushSnapshot,
} from "./context-viz-data.js";

type ContextVizView = "overview" | "detail";

// Context report only changes between turns, so a high polling cadence is
// unnecessary and causes expensive transcript scans on sessions.usage.
// 10 seconds is sufficient; manual refresh via "r" is available for immediacy.
const REFRESH_INTERVAL_MS = 10_000;
const SEPARATOR_CHAR = "\u2500";

export type ContextVizOptions = {
  fetchReport: () => Promise<SessionSystemPromptReport | null>;
  getTokenInfo: () => SessionTokenInfo;
  onClose: () => void;
  requestRender: () => void;
};

export class ContextVizOverlay implements Component {
  private view: ContextVizView = "overview";
  private selectedIndex = 0;
  private scrollOffset = 0;
  private report: SessionSystemPromptReport | null = null;
  private categories: CategoryBreakdown[] = [];
  private detailItems: CategoryDetailItem[] = [];
  private history: ContextHistory;
  private tokenInfo: SessionTokenInfo = { totalTokens: null, contextTokens: null };
  private timer: ReturnType<typeof setInterval> | null = null;
  private options: ContextVizOptions;

  constructor(options: ContextVizOptions) {
    this.options = options;
    this.history = createHistory(60);
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async refresh(): Promise<void> {
    try {
      const report = await this.options.fetchReport();
      if (report) {
        // Skip update if the report hasn't changed since last fetch
        if (!this.report || report.generatedAt !== this.report.generatedAt) {
          this.report = report;
          this.categories = getCategoryBreakdown(report);
          const totalChars = getTotalChars(report);
          pushSnapshot(this.history, totalChars);
          if (this.view === "detail") {
            const cat = this.categories[this.selectedIndex];
            if (cat) {
              this.detailItems = getCategoryDetail(report, cat.category);
            }
          }
        }
      }
      this.tokenInfo = this.options.getTokenInfo();
      this.options.requestRender();
    } catch {
      // Silently ignore fetch errors; keep last known state
    }
  }

  invalidate(): void {
    // pi-tui calls this when the component should re-render; no-op since render() is stateless
  }

  render(width: number): string[] {
    if (!this.report) {
      return [
        "",
        theme.header("  \u{1F9E0} Context Engine"),
        `  ${theme.dim(SEPARATOR_CHAR.repeat(Math.max(0, width - 4)))}`,
        "",
        `  ${theme.dim("Loading context data...")}`,
        "",
      ];
    }

    if (this.view === "detail") {
      return this.renderDetail(width);
    }
    return this.renderOverview(width);
  }

  private renderOverview(width: number): string[] {
    const lines: string[] = [];
    const innerWidth = Math.max(20, width - 4);
    const totalChars = getTotalChars(this.report!);
    const maxCategoryChars = Math.max(...this.categories.map((c) => c.chars), 1);

    // Header
    const title = "\u{1F9E0} Context Engine";
    const totalLabel = `Total: ${formatCharsAndTokens(totalChars)}`;
    const headerPad = Math.max(1, innerWidth - title.length - totalLabel.length);
    lines.push("");
    lines.push(`  ${theme.header(title)}${" ".repeat(headerPad)}${theme.dim(totalLabel)}`);
    lines.push(`  ${theme.dim(SEPARATOR_CHAR.repeat(innerWidth))}`);

    // Proportional stacked bar
    const stackedBarWidth = Math.max(10, innerWidth);
    const stackedBar = renderProportionalBar(
      this.categories.map((c) => ({ category: c.category, value: c.chars })),
      stackedBarWidth,
    );
    lines.push(`  ${stackedBar}`);
    lines.push("");

    // Category rows with bars
    const labelWidth = 18;
    const statsWidth = 30;
    const barWidth = Math.max(8, innerWidth - labelWidth - statsWidth - 4);

    for (let i = 0; i < this.categories.length; i++) {
      const cat = this.categories[i];
      const isSelected = i === this.selectedIndex;
      const prefix = isSelected ? chalk.hex(palette.accent)("\u25B6 ") : "  ";
      const hex = getCategoryColor(cat.category);
      const bar = renderCategoryBar(
        cat.label,
        cat.chars,
        maxCategoryChars,
        labelWidth,
        barWidth,
        hex,
      );
      const stats = ` ${formatCharsAndTokens(cat.chars)}`;
      const line = `  ${prefix}${bar}${theme.dim(stats)}`;
      lines.push(isSelected ? chalk.bold(line) : line);
    }
    lines.push("");

    // Growth sparkline
    const sparkValues = this.history.snapshots.map((s) => s.totalChars);
    if (sparkValues.length >= 2) {
      const sparkWidth = Math.max(10, Math.min(40, innerWidth - 30));
      const spark = renderSparkline(sparkValues, sparkWidth);
      const first = formatInt(sparkValues[0]);
      const last = formatInt(sparkValues[sparkValues.length - 1]);
      lines.push(`  ${theme.dim("Growth:")} ${spark}  ${theme.dim(`(${first} \u2192 ${last})`)}`);
    } else {
      lines.push(`  ${theme.dim("Growth: awaiting data...")}`);
    }

    lines.push(`  ${theme.dim(SEPARATOR_CHAR.repeat(innerWidth))}`);

    // Token utilization bar
    const { totalTokens, contextTokens } = this.tokenInfo;
    if (totalTokens != null && contextTokens != null && contextTokens > 0) {
      const pct = Math.round((totalTokens / contextTokens) * 100);
      const tokenBarWidth = Math.max(10, innerWidth - 30);
      const tokenBar = renderHorizontalBar(totalTokens, contextTokens, tokenBarWidth);
      lines.push(
        `  ${theme.dim("Tokens:")} ${tokenBar}  ${theme.dim(`${pct}% of ${formatInt(contextTokens)} ctx`)}`,
      );
    } else {
      const totalLabel = totalTokens != null ? formatInt(totalTokens) : "unknown";
      const ctxLabel = contextTokens != null ? formatInt(contextTokens) : "?";
      lines.push(`  ${theme.dim(`Tokens: ${totalLabel} / ctx=${ctxLabel}`)}`);
    }

    lines.push(`  ${theme.dim(SEPARATOR_CHAR.repeat(innerWidth))}`);

    // Footer
    lines.push(
      `  ${theme.dim("[Enter]")} drill in  ${theme.dim("[Esc]")} close  ${theme.dim("[\u2191\u2193/jk]")} navigate  ${theme.dim("[r]")} refresh`,
    );
    lines.push("");

    return lines;
  }

  private renderDetail(width: number): string[] {
    const lines: string[] = [];
    const innerWidth = Math.max(20, width - 4);
    const cat = this.categories[this.selectedIndex];
    if (!cat) {
      return this.renderOverview(width);
    }

    const totalLabel = `${cat.itemCount} items, ${formatCharsAndTokens(cat.chars)}`;
    const headerText = `\u25C0 ${cat.label}`;
    const headerPad = Math.max(1, innerWidth - headerText.length - totalLabel.length);

    lines.push("");
    lines.push(`  ${theme.header(headerText)}${" ".repeat(headerPad)}${theme.dim(totalLabel)}`);
    lines.push(`  ${theme.dim(SEPARATOR_CHAR.repeat(innerWidth))}`);

    if (this.detailItems.length === 0) {
      lines.push(`  ${theme.dim("No items")}`);
    } else {
      const maxChars = Math.max(...this.detailItems.map((d) => d.chars), 1);
      const nameWidth = Math.min(20, Math.max(...this.detailItems.map((d) => d.name.length)));
      const statusWidth = this.detailItems.some((d) => d.status) ? 12 : 0;
      const statsWidth = 28;
      const barWidth = Math.max(6, innerWidth - nameWidth - statusWidth - statsWidth - 6);

      // Scrollable view
      const maxVisible = Math.max(1, Math.min(this.detailItems.length, 20));
      const startIndex = Math.max(
        0,
        Math.min(this.scrollOffset, this.detailItems.length - maxVisible),
      );
      const endIndex = Math.min(startIndex + maxVisible, this.detailItems.length);

      for (let i = startIndex; i < endIndex; i++) {
        const item = this.detailItems[i];
        const isSelected = i === this.scrollOffset;
        const prefix = isSelected ? chalk.hex(palette.accent)("\u25B6 ") : "  ";
        const truncatedName =
          item.name.length > nameWidth ? `${item.name.slice(0, nameWidth - 1)}\u2026` : item.name;
        const name = truncatedName.padEnd(nameWidth);
        const statusStr = item.status ? statusColor(item.status).padEnd(statusWidth) : "";
        const hex = getCategoryColor(cat.category);
        const bar = renderHorizontalBar(item.chars, maxChars, barWidth, hex);
        const stats = ` ${formatCharsAndTokens(item.chars)}`;
        const extra = item.extra ? `  ${theme.dim(item.extra)}` : "";
        const line = `  ${prefix}${name} ${statusStr}${bar}${theme.dim(stats)}${extra}`;
        lines.push(isSelected ? chalk.bold(line) : line);
      }

      if (this.detailItems.length > maxVisible) {
        lines.push(`  ${theme.dim(`${this.scrollOffset + 1}/${this.detailItems.length}`)}`);
      }
    }

    lines.push(`  ${theme.dim(SEPARATOR_CHAR.repeat(innerWidth))}`);
    lines.push(
      `  ${theme.dim("[Esc/Backspace]")} back  ${theme.dim("[\u2191\u2193/jk]")} scroll  ${theme.dim("[q]")} close`,
    );
    lines.push("");

    return lines;
  }

  handleInput(keyData: string): void {
    if (isKeyRelease(keyData)) {
      return;
    }

    if (this.view === "overview") {
      this.handleOverviewInput(keyData);
    } else {
      this.handleDetailInput(keyData);
    }
  }

  private handleOverviewInput(keyData: string): void {
    if (matchesKey(keyData, "up") || keyData === "k") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(keyData, "down") || keyData === "j") {
      this.selectedIndex = Math.min(this.categories.length - 1, this.selectedIndex + 1);
      return;
    }
    if (matchesKey(keyData, "enter")) {
      const cat = this.categories[this.selectedIndex];
      if (cat && this.report) {
        this.detailItems = getCategoryDetail(this.report, cat.category);
        this.scrollOffset = 0;
        this.view = "detail";
      }
      return;
    }
    if (keyData === "r") {
      void this.refresh();
      return;
    }
    if (matchesKey(keyData, "escape") || keyData === "q") {
      this.dispose();
      this.options.onClose();
    }
  }

  private handleDetailInput(keyData: string): void {
    if (matchesKey(keyData, "up") || keyData === "k") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      return;
    }
    if (matchesKey(keyData, "down") || keyData === "j") {
      this.scrollOffset = Math.min(this.detailItems.length - 1, this.scrollOffset + 1);
      return;
    }
    if (matchesKey(keyData, "escape") || matchesKey(keyData, "backspace")) {
      this.view = "overview";
      this.scrollOffset = 0;
      return;
    }
    if (keyData === "q") {
      this.dispose();
      this.options.onClose();
    }
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "OK":
      return chalk.hex(palette.success)(status);
    case "MISSING":
      return chalk.hex(palette.error)(status);
    case "TRUNCATED":
      return chalk.hex(palette.accentSoft)(status);
    default:
      return status;
  }
}
