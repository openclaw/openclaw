import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import type { ComposerDraftTransaction } from "../../lib/composer-draft-transaction.ts";
import type { DictationPunctuationPolicy } from "../../lib/dictation-refinement.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { GatewaySpeechPlayback } from "../../lib/speech-playback.ts";
import type { ComposerDictationRecording } from "./composer-dictation-recording.ts";
import type {
  ComposerRefinementScope,
  ComposerRefinementTarget,
  ComposerReviewedCommit,
} from "./composer-dictation-refinement.ts";
import type { placeComposerDictation } from "./composer-dictation-session.ts";
import type { RealtimeTalkLevelSignal } from "./talk/level.ts";

const HOLD_ARM_DELAY_MS = 150,
  HOLD_PROGRESS_MS = 350;

type DictationPhase = "idle" | "pressing" | "holding" | "connecting" | "recording" | "stopping";

type ComposerDictationFailure = {
  kind: "interrupted" | "start" | "busy";
  preservesText: boolean;
};

export type ComposerDictationOwnerOptions = {
  client: GatewayBrowserClient | null;
  sessionKey?: string;
  prepareSession?: () => Promise<string | undefined>;
  draftKey?: string;
  accountId?: string;
  getDraftRevision?: () => number;
  getDraftText?: () => string | undefined;
  /** Only destinations with an exact reviewed-text insertion contract opt in. */
  refinementAvailable?: boolean;
  connected: boolean;
  enabled: boolean;
  dictationAvailable?: boolean;
  realtimeTalkActive: boolean;
  refinement?: { policy: DictationPunctuationPolicy };
  readRefinementTarget?: () => ComposerRefinementTarget | undefined;
  onCommit: (
    text: string,
    late?: true,
    preservePreview?: true,
    reviewed?: ComposerReviewedCommit,
  ) => boolean | void | ComposerDraftTransaction;
  onError: (message: string, failure: ComposerDictationFailure) => void;
  onTap?: () => void;
  onDictationUnavailable?: () => void;
};

// Gesture and session admission must remain synchronous across pointer and media callbacks.
export class ComposerDictationOwner extends EventTarget {
  private readonly playback = new GatewaySpeechPlayback();
  private phase: DictationPhase = "idle";
  private pointerId: number | null = null;
  private pointerTarget: HTMLElement | null = null;
  private pointerBounds: DOMRect | null = null;
  private pointerListeners: AbortController | null = null;
  private suppressionListeners: AbortController | null = null;
  private cancellationListeners: AbortController | null = null;
  private holdTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private captureStart: { review: boolean; punctuation: boolean } | undefined;
  private recording: ComposerDictationRecording | undefined;
  private suppressedPointerId: number | null = null;
  private suppressClickTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private disposed = false;
  private refinementSelected = false;
  refinementOptionsOpen = false;

  constructor(private options: ComposerDictationOwnerOptions) {
    super();
  }

  subscribe(listener: () => void) {
    return listen(this, "change", listener);
  }

  get active(): boolean {
    return this.phase === "connecting" || this.phase === "recording" || this.phase === "stopping";
  }

  get connecting(): boolean {
    return this.phase === "connecting";
  }

  get arming(): boolean {
    return this.phase === "holding";
  }

  get finalizing(): boolean {
    return this.phase === "stopping";
  }

  // Stop releases the microphone and typing lock before the final text arrives.
  get transcribing(): boolean {
    return Boolean(this.recording?.commits.size) || this.refinement?.busy === true;
  }

  get refinementEnabled(): boolean {
    return this.refinementSelected;
  }

  get refinementPreferenceLocked(): boolean {
    return this.locksComposer || this.transcribing || this.pendingReview;
  }

  get refinementAvailable(): boolean {
    return this.options.refinementAvailable === true;
  }

  get refinement() {
    return this.recording?.refinement;
  }

  get requiresReview(): boolean {
    return this.captureStart?.review === true || this.refinement?.pending === true;
  }

  get pendingReview(): boolean {
    return this.requiresReview;
  }

  get punctuationEnabled(): boolean {
    if (this.captureStart) {
      return this.captureStart.punctuation;
    }
    if (this.refinement?.pending || this.review) {
      return this.refinement?.punctuation === true;
    }
    return this.options.refinement !== undefined;
  }

  get review() {
    return this.refinement?.review ?? null;
  }

  reprocess(policy: DictationPunctuationPolicy): Promise<boolean> {
    return this.refinement?.reprocess(policy) ?? Promise.resolve(false);
  }

  chooseOriginal(): boolean {
    return this.refinement?.chooseOriginal() === true;
  }

  insertReviewed(): boolean {
    return (
      this.refinement?.accept(this.review?.selected === "original" ? "raw" : "candidate") === true
    );
  }

  undoReviewed(): boolean {
    return this.refinement?.undoReviewed() === true;
  }

  dismissReview(): void {
    this.refinement?.dismissReview();
  }

  toggleRefinementOptions(): void {
    this.setRefinementOptionsOpen(!this.refinementOptionsOpen);
  }

  setRefinementOptionsOpen(open: boolean): void {
    if (this.refinementOptionsOpen === open) {
      return;
    }
    this.refinementOptionsOpen = open;
    this.dispatchEvent(new Event("change"));
  }

  setRefinementEnabled(enabled: boolean): void {
    if (
      this.refinementPreferenceLocked ||
      !this.refinementAvailable ||
      this.refinementSelected === enabled
    ) {
      return;
    }
    this.refinementSelected = enabled;
    this.dispatchEvent(new Event("change"));
  }

  invalidateRefinement(): void {
    const owner = this.refinement;
    if (!owner) {
      return;
    }
    owner.reconcile(this.recording?.session?.transcriptSnapshot());
    if (this.recording?.session && this.captureStart?.review && owner.phase !== "recording") {
      // Reconciliation already retired the review. Stop its mic, not its manual recovery.
      void this.stop({ commit: false });
    }
  }

  get locksComposer(): boolean {
    return this.phase !== "idle";
  }

  /** Places a transcript in a draft; there is nothing to place before capture loads. */
  placeTranscript(
    ...args: Parameters<typeof placeComposerDictation>
  ): ReturnType<typeof placeComposerDictation> | undefined {
    return this.recording?.commits.place(...args);
  }

  get inputLevel(): RealtimeTalkLevelSignal | undefined {
    return this.recording?.session?.inputLevel;
  }

  get transcript(): string {
    // Opt-in refinement keeps provisional captions out of the editable draft.
    return this.requiresReview ? "" : (this.recording?.session?.transcriptSnapshot() ?? "");
  }

  get provisionalTranscript(): string {
    const text = this.recording?.session?.transcriptSnapshot() ?? "";
    return this.refinement?.boundedCaption(text) ?? "";
  }

  // Returns the stop promise so the confirming control can remain tied to the
  // session that actually inserted text into the draft.
  finishActive(): Promise<boolean> {
    return this.stop({ commit: true });
  }

  startDirect(): boolean {
    if (this.phase !== "idle" || !this.canHold()) {
      return false;
    }
    // Surfaces without Talk do not need the hold discriminator. Enter the same
    // session start path directly so capture, errors, partials and finalization stay canonical.
    this.setPhase("holding");
    void this.start();
    return true;
  }

  update(options: ComposerDictationOwnerOptions): void {
    if (
      this.options.client !== options.client ||
      this.options.sessionKey !== options.sessionKey ||
      this.options.draftKey !== options.draftKey
    ) {
      this.cancel(false);
    }
    this.options = options;
    if (!this.refinementAvailable) {
      if (this.refinementSelected) {
        this.cancel();
        this.refinementSelected = false;
        this.dispatchEvent(new Event("change"));
      }
      this.setRefinementOptionsOpen(false);
    }
    this.invalidateRefinement();
    if (!options.connected) {
      this.recording?.commits.markGatewayDisconnected();
    }
    if (this.phase === "stopping") {
      return;
    }
    if (this.phase !== "idle" && !this.canHold()) {
      const keepFinal = this.active && !options.connected;
      const preservesText = keepFinal
        ? (this.recording?.session?.markGatewayDisconnected() ?? false)
        : false;
      void this.stop({ commit: keepFinal });
      // Empty drains report through the session; retained text still needs this notice.
      if (keepFinal && preservesText) {
        options.onError(t("chat.composer.dictationDisconnected"), {
          kind: "interrupted",
          preservesText,
        });
      }
    }
  }

  handlePointerDown(event: PointerEvent): boolean {
    if (event.button === 0 && this.active) {
      // A new press is explicit Stop, even if the held release was lost outside the window.
      this.clearClickSuppression();
    }
    if (event.button !== 0 || this.phase !== "idle" || !this.canHold()) {
      return false;
    }
    event.preventDefault();
    this.pointerId = event.pointerId;
    this.pointerTarget = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    this.pointerBounds = this.pointerTarget?.getBoundingClientRect() ?? null;
    this.pointerTarget?.setPointerCapture?.(event.pointerId);
    this.pointerListeners = new AbortController();
    const pointerOptions = { signal: this.pointerListeners.signal };
    if (this.pointerTarget) {
      listen(
        this.pointerTarget,
        "lostpointercapture",
        this.handleDocumentPointerCancel,
        pointerOptions,
      );
    }
    this.suppressedPointerId = event.pointerId;
    this.setPhase("pressing");
    // A normal click gets a quiet grace period. Only a sustained press enters
    // the visible 350ms ring, so the hold affordance cannot steal tap-to-talk.
    this.holdTimer = globalThis.setTimeout(() => {
      if (this.phase !== "pressing") {
        return;
      }
      this.setPhase("holding");
      this.holdTimer = globalThis.setTimeout(() => void this.start(), HOLD_PROGRESS_MS);
    }, HOLD_ARM_DELAY_MS);
    listen(document, "pointermove", this.handleDocumentPointerMove, pointerOptions);
    listen(document, "pointerup", this.handleDocumentPointerUp, pointerOptions);
    listen(document, "pointercancel", this.handleDocumentPointerCancel, pointerOptions);
    listen(document, "visibilitychange", this.handleGestureInterruption, pointerOptions);
    listen(window, "blur", this.handleGestureInterruption, pointerOptions);
    this.suppressionListeners?.abort();
    this.suppressionListeners = new AbortController();
    const suppressionOptions = { signal: this.suppressionListeners.signal };
    listen(document, "pointerup", this.handleSuppressedPointerRelease, suppressionOptions);
    listen(document, "pointercancel", this.handleSuppressedPointerRelease, suppressionOptions);
    return true;
  }

  handleClick(event: MouseEvent): void {
    if (this.suppressedPointerId !== null) {
      this.clearClickSuppression();
      // Keyboard/assistive Stop has no pointer-release click to suppress.
      if (event.detail !== 0 || !this.active) {
        event.preventDefault();
        return;
      }
    }
    if (this.active) {
      void this.finishActive();
    } else if (this.phase === "idle") {
      this.options.onTap?.();
      return;
    }
    event.preventDefault();
  }

  handleContextMenu(event: MouseEvent): void {
    if (this.phase !== "idle") {
      event.preventDefault();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancel(false);
  }

  cancel(keepReceipt = true): void {
    this.refinement?.cancel(keepReceipt);
    this.clearClickSuppression();
    this.playback.stop();
    if (this.recording?.commits.size) {
      this.recording.commits.retire();
      this.pendingCommitsChanged();
    }
    void this.stop({ commit: false });
  }

  private readonly handleDocumentPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId || !this.pointerBounds) {
      return;
    }
    const rect = this.pointerBounds;
    const outside =
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom;
    if (outside) {
      void this.stop({ commit: false });
    }
  };

  private readonly handleDocumentPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) {
      return;
    }
    if (this.phase === "pressing" || this.phase === "holding") {
      const cleanTap = this.phase === "pressing";
      this.clearPointerGesture();
      this.setPhase("idle");
      if (cleanTap) {
        this.options.onTap?.();
      }
      this.expireClickSuppression();
      return;
    }
    void this.stop({ commit: true });
  };

  private readonly handleDocumentPointerCancel = (event: PointerEvent): void => {
    if (event.pointerId === this.pointerId) {
      void this.stop({ commit: false });
    }
  };

  private readonly handleSuppressedPointerRelease = (event: PointerEvent): void => {
    if (event.pointerId === this.suppressedPointerId) {
      this.expireClickSuppression();
    }
  };

  private readonly handleDocumentKeyDown = (event: KeyboardEvent): void => {
    if (
      event.key !== "Escape" ||
      (this.phase === "idle" && !this.transcribing && !this.pendingReview && !this.review)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (this.phase === "idle" && !this.transcribing && this.review) {
      this.dismissReview();
    } else {
      this.cancel();
    }
  };

  // Only an unfinished hold gesture depends on focus/visibility. Latching capture
  // removes these listeners with the pointer gesture, so background dictation continues.
  private readonly handleGestureInterruption = (event: Event): void => {
    if (event.type === "visibilitychange" && document.visibilityState !== "hidden") {
      return;
    }
    this.clearClickSuppression();
    void this.stop({ commit: false });
  };

  private canHold(): boolean {
    return (
      this.options.enabled &&
      this.options.connected &&
      !this.options.realtimeTalkActive &&
      this.options.client !== null
    );
  }

  private readRefinementScope(punctuation: boolean): ComposerRefinementScope {
    return {
      connection: this.options.client,
      connectionGeneration: this.options.client?.connectionGeneration ?? 0,
      authority: this.options.client?.auth ?? null,
      accountId: this.options.accountId ?? "connection",
      target: this.options.draftKey ?? this.options.sessionKey ?? "composer",
      draftRevision: this.options.getDraftRevision?.() ?? 0,
      draftText: this.options.getDraftText?.(),
      permitted:
        !this.disposed &&
        this.canHold() &&
        (punctuation
          ? this.options.refinementAvailable !== false && !!this.options.readRefinementTarget
          : this.refinementAvailable && this.refinementSelected),
      locale: navigator.language || (punctuation ? "und" : "en"),
    };
  }

  private async start(): Promise<void> {
    const client = this.options.client;
    if (this.phase !== "holding" || !client || !this.canHold()) {
      await this.stop({ commit: false });
      return;
    }
    if (this.options.dictationAvailable === false && !this.options.prepareSession) {
      this.clearPointerGesture();
      this.setPhase("idle");
      this.options.onDictationUnavailable?.();
      // The held pointer still owns a synthetic click. Its release expires this
      // suppression only after handleClick has had a chance to consume the tail.
      return;
    }
    // Crossing the threshold latches dictation. Recording no longer depends on
    // the pointer, window focus, or page visibility; explicit controls still stop it.
    this.clearPointerGesture();
    this.refinement?.cancel(false);
    // Settings apply to the next capture, never to a previous recording that is still draining.
    const policy = this.options.refinement?.policy;
    const captureStart = {
      review: Boolean(policy) || this.refinementSelected,
      punctuation: !!policy,
    };
    const scope = captureStart.review
      ? this.readRefinementScope(captureStart.punctuation)
      : undefined;
    const target = policy ? this.options.readRefinementTarget?.() : undefined;
    if (scope && (!scope.permitted || (policy && (!target || target.selectionCurrent === false)))) {
      await this.stop({ commit: false });
      return;
    }
    const punctuation =
      policy && target ? { policy: { ...policy }, target: { ...target } } : undefined;
    if (scope) {
      this.recording?.commits.retire();
    }
    this.captureStart = captureStart;
    this.setPhase("connecting");
    if (this.captureStart !== captureStart) {
      return;
    }
    let describeStartError = (error: unknown): [string, ComposerDictationFailure["kind"]] => [
      formatUiError(error),
      "start",
    ];
    try {
      // Preserve Safari playback activation before the lazy capture module loads.
      this.playback.prepare(client, () => this.cancel());
      const sessionKey = this.options.prepareSession
        ? await this.options.prepareSession()
        : this.options.sessionKey;
      const { ComposerDictationRecording, describeDictationStartError } =
        await import("./composer-dictation-recording.ts");
      const isCurrent = () =>
        this.captureStart === captureStart && !this.disposed && this.connecting && this.canHold();
      if (!isCurrent()) {
        return;
      }
      describeStartError = describeDictationStartError;
      this.recording ??= new ComposerDictationRecording({
        options: () => this.options,
        readScope: (punctuation) => this.readRefinementScope(punctuation),
        changed: () => this.pendingCommitsChanged(),
        ready: () => this.setPhase("recording"),
        stop: (commit) => this.stop({ commit }),
      });
      await this.recording.start(client, sessionKey, scope, punctuation, isCurrent);
    } catch (error) {
      if (this.captureStart !== captureStart || this.disposed || this.finalizing) {
        return;
      }
      const [message, kind] = describeStartError(error);
      this.options.onError(message, { kind, preservesText: false });
      await this.stop({ commit: false });
    }
  }

  private stop(options: { commit: boolean }): Promise<boolean> {
    const reviewRequired = this.captureStart?.review === true;
    this.captureStart = undefined;
    if (this.phase === "idle" || this.phase === "stopping") {
      return Promise.resolve(false);
    }
    const wasActive = this.active;
    this.clearPointerGesture();
    const recording = this.recording;
    const session = recording?.session;
    if (!recording || !session) {
      if (this.refinement?.phase === "recording") {
        this.refinement.cancel();
      }
      this.setPhase("idle");
      this.releasePlayback();
      return Promise.resolve(false);
    }
    this.setPhase("stopping");
    recording.session = null;
    this.setPhase("idle");
    if (!options.commit) {
      if (this.refinement?.phase === "recording") {
        this.refinement.cancel();
      }
      this.releasePlayback();
      void session.cancel().catch(() => undefined);
      return Promise.resolve(false);
    }
    if (reviewRequired) {
      this.playback.stop();
      // A review-required Stop never becomes an ordinary insertion if its capture was cancelled.
      return this.refinement ? this.refinement.finish(session) : session.cancel().then(() => false);
    }
    // Capture and typing unlock immediately. Stopped recordings retain ownership
    // and commit in capture order, even when a later provider finishes first.
    const committed = recording.commits.add(session, (lateTranscript) => {
      this.releasePlayback();
      this.pendingCommitsChanged();
      if (
        !lateTranscript ||
        !wasActive ||
        this.disposed ||
        !this.options.enabled ||
        this.options.realtimeTalkActive
      ) {
        return false;
      }
      if (this.active) {
        this.options.onCommit(lateTranscript, true, true);
      } else {
        this.options.onCommit(lateTranscript, true);
      }
      this.dispatchEvent(new Event("change"));
      return true;
    });
    this.pendingCommitsChanged();
    return committed;
  }

  private releasePlayback(): void {
    if (this.phase === "idle" && !this.transcribing) {
      this.playback.stop();
    }
  }

  private pendingCommitsChanged(): void {
    this.syncCancellationListeners();
    this.dispatchEvent(new Event("change"));
  }

  private clearPointerGesture(): void {
    globalThis.clearTimeout(this.holdTimer ?? undefined);
    this.holdTimer = null;
    this.pointerListeners?.abort();
    this.pointerListeners = null;
    if (this.pointerId !== null) {
      try {
        this.pointerTarget?.releasePointerCapture?.(this.pointerId);
      } catch {
        // A reactive render can replace the button and implicitly release capture first.
      }
    }
    this.pointerId = null;
    this.pointerTarget = null;
    this.pointerBounds = null;
  }

  private expireClickSuppression(): void {
    if (this.suppressedPointerId === null || this.suppressClickTimer !== null) {
      return;
    }
    this.suppressClickTimer = globalThis.setTimeout(() => this.clearClickSuppression(), 0);
  }

  private clearClickSuppression(): void {
    globalThis.clearTimeout(this.suppressClickTimer ?? undefined);
    this.suppressClickTimer = null;
    this.suppressionListeners?.abort();
    this.suppressionListeners = null;
    this.suppressedPointerId = null;
  }

  private setPhase(phase: DictationPhase): void {
    if (this.phase === phase) {
      return;
    }
    this.phase = phase;
    this.syncCancellationListeners();
    this.dispatchEvent(new Event("change"));
  }

  private syncCancellationListeners(): void {
    if (
      !this.disposed &&
      (this.phase !== "idle" || this.transcribing || this.pendingReview || this.review)
    ) {
      if (this.cancellationListeners) {
        return;
      }
      this.cancellationListeners = new AbortController();
      const options = { signal: this.cancellationListeners.signal };
      listen(document, "keydown", this.handleDocumentKeyDown, options);
    } else {
      this.cancellationListeners?.abort();
      this.cancellationListeners = null;
    }
  }
}
