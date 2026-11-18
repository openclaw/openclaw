import type { BoardWidget } from "../../lib/board/types.ts";
import { remainingBoardWidgetTicketTtlMs } from "../../lib/board/widget-ticket-lifetime.ts";

const TICKET_REFRESH_LEAD_MS = 15_000;
const TICKET_REFRESH_MIN_DELAY_MS = 1_000;
const TICKET_REFRESH_RETRY_MS = 1_000;
const TICKET_REFRESH_MAX_RETRY_MS = 30_000;

export type FrameRefresh = (name: string) => Promise<void>;

export class BoardWidgetTicketRefresh {
  private timer: number | null = null;
  private attempts = 0;
  private scheduledTicket = "";

  constructor(
    private readonly currentTicket: () => string | undefined,
    private readonly canRefresh: () => boolean,
  ) {}

  private clearTimer(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  reset(): void {
    this.clearTimer();
    this.attempts = 0;
    this.scheduledTicket = "";
  }

  schedule(widget: BoardWidget | undefined, refresh: FrameRefresh | undefined): void {
    const ticket = widget?.viewTicket;
    const remainingTtlMs = widget ? remainingBoardWidgetTicketTtlMs(widget) : undefined;
    if (!this.canRefresh() || !widget || !refresh || !ticket || remainingTtlMs === undefined) {
      this.reset();
      return;
    }
    if (this.scheduledTicket === ticket) {
      return;
    }
    this.clearTimer();
    this.attempts = 0;
    this.scheduledTicket = ticket;
    const delayMs = Math.max(TICKET_REFRESH_MIN_DELAY_MS, remainingTtlMs - TICKET_REFRESH_LEAD_MS);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.refresh(widget.name, ticket, refresh);
    }, delayMs);
  }

  private refresh(name: string, ticket: string, refresh: FrameRefresh): void {
    if (!this.canRefresh()) {
      this.reset();
      return;
    }
    if (this.currentTicket() !== ticket || this.scheduledTicket !== ticket) {
      return;
    }
    this.attempts += 1;
    const retryIfUnchanged = () => {
      if (this.currentTicket() !== ticket || this.scheduledTicket !== ticket) {
        return;
      }
      // A fulfilled refresh may be discarded by a superseding provider mutation.
      // Retry until this exact expiring ticket is actually replaced.
      this.clearTimer();
      this.timer = window.setTimeout(
        () => {
          this.timer = null;
          this.refresh(name, ticket, refresh);
        },
        Math.min(TICKET_REFRESH_RETRY_MS * this.attempts, TICKET_REFRESH_MAX_RETRY_MS),
      );
    };
    void refresh(name).then(retryIfUnchanged, retryIfUnchanged);
  }
}
