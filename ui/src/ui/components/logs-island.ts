/**
 * Logs Island - Interactive logs viewer for Astro.
 * Wraps the existing renderLogs view with gateway service calls.
 */

import { StoreController } from "@nanostores/lit";
import { LitElement, html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { gateway } from "../../services/gateway.ts";
import { $connected } from "../../stores/app.ts";
import { parseLogLine } from "../controllers/logs.ts";
import type { LogEntry, LogLevel } from "../types.ts";
import { renderLogs, type LogsProps } from "../views/logs.ts";

const LOG_BUFFER_LIMIT = 2000;
const POLL_INTERVAL_MS = 2000;

@customElement("logs-island")
export class LogsIsland extends LitElement {
  private connectedCtrl = new StoreController(this, $connected);

  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private file: string | null = null;
  @state() private entries: LogEntry[] = [];
  @state() private filterText = "";
  @state() private levelFilters: Record<LogLevel, boolean> = {
    trace: true,
    debug: true,
    info: true,
    warn: true,
    error: true,
    fatal: true,
  };
  @state() private autoFollow = true;
  @state() private truncated = false;

  private cursor: number | null = null;
  private shouldAutoScroll = true;
  private pollingInterval: ReturnType<typeof setInterval> | null = null;

  protected createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    void this.loadLogs({ reset: true });
    this.startPolling();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.stopPolling();
  }

  render(): TemplateResult {
    const props: LogsProps = {
      loading: this.loading,
      error: this.error,
      file: this.file,
      entries: this.entries,
      filterText: this.filterText,
      levelFilters: this.levelFilters,
      autoFollow: this.autoFollow,
      truncated: this.truncated,
      onFilterTextChange: (next: string) => {
        this.filterText = next;
      },
      onLevelToggle: (level: LogLevel, enabled: boolean) => {
        this.levelFilters = { ...this.levelFilters, [level]: enabled };
      },
      onToggleAutoFollow: (next: boolean) => {
        this.autoFollow = next;
        if (next) {
          this.scrollToBottom();
        }
      },
      onRefresh: () => {
        void this.loadLogs({ reset: true });
      },
      onExport: (lines: string[], label: string) => {
        this.exportLogs(lines, label);
      },
      onScroll: (event: Event) => {
        this.handleScroll(event);
      },
    };

    return html`${renderLogs(props)}`;
  }

  updated() {
    if (this.autoFollow && this.shouldAutoScroll) {
      this.scrollToBottom();
    }
  }

  private async loadLogs(opts?: { reset?: boolean; quiet?: boolean }) {
    if (!this.connectedCtrl.value) {
      return;
    }
    if (this.loading && !opts?.quiet) {
      return;
    }
    if (!opts?.quiet) {
      this.loading = true;
    }
    this.error = null;
    try {
      const res = await gateway.call<{
        file?: string;
        cursor?: number;
        size?: number;
        lines?: unknown;
        truncated?: boolean;
        reset?: boolean;
      }>("logs.tail", {
        cursor: opts?.reset ? undefined : (this.cursor ?? undefined),
        limit: 200,
        maxBytes: 512_000,
      });
      const lines = Array.isArray(res.lines)
        ? res.lines.filter((line): line is string => typeof line === "string")
        : [];
      const parsed = lines.map(parseLogLine);
      const shouldReset = Boolean(opts?.reset || res.reset || this.cursor == null);
      this.entries = shouldReset ? parsed : [...this.entries, ...parsed].slice(-LOG_BUFFER_LIMIT);
      if (typeof res.cursor === "number") {
        this.cursor = res.cursor;
      }
      if (typeof res.file === "string") {
        this.file = res.file;
      }
      this.truncated = Boolean(res.truncated);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      if (!opts?.quiet) {
        this.loading = false;
      }
    }
  }

  private startPolling() {
    this.pollingInterval = setInterval(() => {
      if (!this.loading && this.connectedCtrl.value) {
        void this.loadLogs({ quiet: true });
      }
    }, POLL_INTERVAL_MS);
  }

  private stopPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  private scrollToBottom() {
    const container = this.querySelector(".log-stream");
    if (container instanceof HTMLElement) {
      container.scrollTop = container.scrollHeight;
    }
  }

  private handleScroll(event: Event) {
    const container = event.target as HTMLElement;
    const isAtBottom =
      Math.abs(container.scrollHeight - container.scrollTop - container.clientHeight) < 10;

    this.shouldAutoScroll = isAtBottom;

    if (!isAtBottom && this.autoFollow) {
      this.autoFollow = false;
    }
  }

  private exportLogs(lines: string[], label: string) {
    const content = lines.join("\n");
    const blob = new Blob([content], { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `openclaw-logs-${label}-${Date.now()}.jsonl`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}
