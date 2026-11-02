import { t } from "../../i18n/index.ts";
import { registerCommandPaletteEnglish } from "../../i18n/locales/en-command-palette.ts";
import { showToast } from "../../lib/toast.ts";
import type { NewSessionDraft } from "./draft.ts";
import type { NewSessionRouteData } from "./location.ts";

registerCommandPaletteEnglish();

// Failed starts keep prompt bytes in memory for Try again; bound what survives dismissal.
const MAX_FAILED_STARTS = 8;

/** One launcher draft; callbacks bind to the slot before its draft exists. */
export class PaletteDraftSlot {
  readonly draft: NewSessionDraft;
  /** The Gateway created the session; its notice and destination own the outcome. */
  accepted = false;
  running = false;
  /** Presentation owner at release; notices never cross to another account or Gateway. */
  scope: unknown;

  constructor(
    public data: NewSessionRouteData,
    createDraft: (slot: PaletteDraftSlot) => NewSessionDraft,
  ) {
    this.draft = createDraft(this);
  }
}

/**
 * Starts the launcher released at send. Each keeps its own draft until it
 * settles, so Cmd+K is free for the next prompt; a failed start stays for Try again.
 */
export class PaletteReleasedStarts {
  private readonly starts = new Set<PaletteDraftSlot>();

  constructor(private readonly readScope: () => unknown) {}

  adopt(slot: PaletteDraftSlot) {
    slot.running = true;
    slot.scope = this.readScope();
    this.starts.add(slot);
  }

  /** Settle on each transition out of submitting, including reconnect resumptions. */
  observe(slot: PaletteDraftSlot) {
    if (!this.starts.has(slot)) {
      return;
    }
    const { submission } = slot.draft;
    if (submission.submitting) {
      slot.running = true;
      return;
    }
    if (!slot.running) {
      return;
    }
    slot.running = false;
    if (slot.scope !== this.readScope()) {
      this.retire(slot);
      return;
    }
    const error =
      submission.error ??
      (submission.submissionOutcomeUnknown ? submission.submitDisabledReason() : undefined);
    if (slot.accepted || !error) {
      this.retire(slot);
      return;
    }
    const failed = [...this.starts].filter((start) => start !== slot && !start.running);
    failed
      .slice(0, Math.max(0, failed.length + 1 - MAX_FAILED_STARTS))
      .forEach((start) => this.retire(start));
    showToast({
      fifo: true,
      message: t("palette.startFailed", { error }),
      actionLabel: t("palette.tryAgain"),
      onAction: () => this.retry(slot),
    });
  }

  retry(slot: PaletteDraftSlot) {
    if (
      this.starts.has(slot) &&
      slot.scope === this.readScope() &&
      !slot.draft.submission.submitting
    ) {
      void slot.draft.submission.submit(undefined, true);
    }
  }

  synchronize() {
    this.starts.forEach((slot) => slot.draft.synchronize());
  }

  settled() {
    this.starts.forEach((slot) => slot.draft.submission.synchronizeSubmission());
  }

  discard() {
    [...this.starts].forEach((slot) => this.retire(slot));
  }

  private retire(slot: PaletteDraftSlot) {
    this.starts.delete(slot);
    // Settlement publishes from inside the draft's own submission; disconnect after it returns.
    queueMicrotask(() => slot.draft.disconnect());
  }
}
