import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { CronState } from "../../lib/cron/types.ts";

// The page owns request state; this controller owns presentation across panels
// whose controls are replaced rather than retained by Lit.
export class CronPanelController implements ReactiveController {
  private lastPanelKey: string | null = null;
  private lastState: CronState | null = null;
  private overviewFocus: { jobId: string | null; index: number } = { jobId: null, index: 0 };
  private pendingRunScroll = false;
  private focusScrollFrame: number | null = null;
  private pendingFocus: {
    cronState: CronState;
    panelKey: string;
    source: Element | null;
  } | null = null;

  constructor(
    private readonly host: HTMLElement & ReactiveControllerHost,
    private readonly currentState: () => CronState,
    private readonly onPanelChange: () => void,
  ) {
    host.addController(this);
  }

  reset() {
    this.cancelFocusScroll();
    this.pendingFocus = null;
    this.pendingRunScroll = false;
    this.overviewFocus = { jobId: null, index: 0 };
  }

  hostDisconnected() {
    this.reset();
  }

  hostUpdate() {
    const state = this.currentState();
    if (state !== this.lastState) {
      this.reset();
      this.lastState = state;
    }
    const editingJobId = state.cronEditingJob?.id ?? null;
    const mode = editingJobId ? "job" : state.cronCreateOpen ? "create" : "overview";
    const panelKey = `${mode}:${editingJobId ?? ""}`;
    if (panelKey !== this.lastPanelKey) {
      this.lastPanelKey = panelKey;
      this.onPanelChange();
      const scroller = this.host.closest(".content");
      if (scroller instanceof HTMLElement && typeof scroller.scrollTo === "function") {
        scroller.scrollTo({ top: 0 });
      }
    }
  }

  openJob(jobId: string, scrollRun: boolean) {
    this.rememberOverviewFocus(jobId);
    this.pendingRunScroll = scrollRun;
    this.requestFocus(`job:${jobId}`);
  }

  openCreate(jobId: string | null = null) {
    this.rememberOverviewFocus(jobId);
    this.pendingRunScroll = false;
    this.requestFocus("create:");
  }

  close(source = this.host.ownerDocument.activeElement) {
    const state = this.currentState();
    if (!state.cronEditingJob && !state.cronCreateOpen) {
      this.pendingRunScroll = false;
      this.requestFocus("overview:", source);
    }
  }

  hostUpdated() {
    this.focusPanel();
    if (this.pendingRunScroll) {
      const run = this.host.querySelector<HTMLElement>(".cron-run-entry--highlighted");
      if (run) {
        run.scrollIntoView?.({ block: "nearest" });
        this.pendingRunScroll = false;
      }
    }
  }

  private rememberOverviewFocus(jobId: string | null) {
    const rows = [...this.host.querySelectorAll<HTMLElement>(".cron-table__row")];
    const index = rows.findIndex((row) => row.dataset.testId === `cron-row-${jobId}`);
    // Retain the rendered row's identity and visual position, not its detached node.
    this.overviewFocus = { jobId, index: Math.max(0, index) };
  }

  private requestFocus(panelKey: string, source = this.host.ownerDocument.activeElement) {
    this.cancelFocusScroll();
    this.pendingFocus = { cronState: this.currentState(), panelKey, source };
  }

  private focusPanel() {
    const pending = this.pendingFocus;
    this.pendingFocus = null;
    if (
      !pending ||
      !this.host.isConnected ||
      pending.cronState !== this.currentState() ||
      pending.panelKey !== this.lastPanelKey
    ) {
      return;
    }
    const document = this.host.ownerDocument;
    const active = document.activeElement;
    // A slow deletion must not reclaim focus after the operator moved elsewhere.
    if (
      active !== pending.source &&
      active !== document.body &&
      active !== document.documentElement
    ) {
      return;
    }
    let target: HTMLElement | null;
    if (pending.panelKey !== "overview:") {
      target = this.host.querySelector(".cron-back:not(:disabled), .cron-detail-title");
    } else {
      const rows = [...this.host.querySelectorAll<HTMLElement>(".cron-table__row")];
      const row =
        rows.find((entry) => entry.dataset.testId === `cron-row-${this.overviewFocus.jobId}`) ??
        rows[Math.min(this.overviewFocus.index, rows.length - 1)];
      target =
        (this.overviewFocus.jobId === null
          ? this.host.querySelector<HTMLElement>(".cron-new-task:not(:disabled)")
          : null) ??
        row?.querySelector<HTMLElement>(".cron-table__name") ??
        this.host.querySelector<HTMLElement>(".cron-search-box input");
    }
    target?.focus();
    if (target && pending.panelKey === "overview:" && target.scrollIntoView) {
      // Row controls can finish their layout after the page's Lit update.
      // Reveal only the still-owned focused row once that layout has settled.
      this.focusScrollFrame = requestAnimationFrame(() => {
        this.focusScrollFrame = null;
        if (
          target.isConnected &&
          document.activeElement === target &&
          pending.cronState === this.currentState() &&
          pending.panelKey === this.lastPanelKey
        ) {
          target.scrollIntoView({ block: "nearest", behavior: "instant" });
        }
      });
    }
  }

  private cancelFocusScroll() {
    if (this.focusScrollFrame !== null) {
      cancelAnimationFrame(this.focusScrollFrame);
      this.focusScrollFrame = null;
    }
  }
}
