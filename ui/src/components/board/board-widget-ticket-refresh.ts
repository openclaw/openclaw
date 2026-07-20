import type { BoardViewWidget } from "../../lib/board/view-types.ts";
import { remainingBoardWidgetTicketTtlMs } from "../../lib/board/widget-ticket-lifetime.ts";

const REFRESH_LEAD_MS = 15_000;
const REFRESH_MIN_DELAY_MS = 1_000;
const REFRESH_RETRY_MS = 1_000;
const REFRESH_MAX_RETRY_MS = 30_000;

export class BoardWidgetTicketRefresh {
  private timer: number | null = null;
  private attempts = 0;
  private scheduledTicket = "";

  constructor(private readonly currentTicket: () => string | undefined) {}

  clear(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  schedule(
    widget: BoardViewWidget | undefined,
    refresh: ((name: string) => Promise<void>) | undefined,
  ): void {
    const ticket = widget?.viewTicket;
    const remainingTtlMs = widget ? remainingBoardWidgetTicketTtlMs(widget) : undefined;
    if (!widget || !refresh || !ticket || remainingTtlMs === undefined) {
      this.clear();
      this.attempts = 0;
      this.scheduledTicket = "";
      return;
    }
    if (this.scheduledTicket === ticket) {
      return;
    }
    this.clear();
    this.attempts = 0;
    this.scheduledTicket = ticket;
    const delayMs = Math.max(REFRESH_MIN_DELAY_MS, remainingTtlMs - REFRESH_LEAD_MS);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.refresh(widget.name, ticket, refresh);
    }, delayMs);
  }

  private refresh(name: string, ticket: string, refresh: (name: string) => Promise<void>): void {
    if (this.currentTicket() !== ticket || this.scheduledTicket !== ticket) {
      return;
    }
    this.attempts += 1;
    const retryIfUnchanged = () => {
      if (this.currentTicket() !== ticket || this.scheduledTicket !== ticket) {
        return;
      }
      // A fulfilled refresh may still be discarded by a superseding provider
      // mutation. Retry until this exact expiring ticket is actually replaced.
      this.clear();
      this.timer = window.setTimeout(
        () => {
          this.timer = null;
          this.refresh(name, ticket, refresh);
        },
        Math.min(REFRESH_RETRY_MS * this.attempts, REFRESH_MAX_RETRY_MS),
      );
    };
    void refresh(name).then(retryIfUnchanged, retryIfUnchanged);
  }
}
