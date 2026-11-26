import {
  loadUiPreferences,
  patchSettings,
  readLiveUiPreferences,
  settingsKeyForGateway,
  subscribeSettingsChanges,
} from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { GatewaySpeechPlayback } from "../../lib/speech-playback.ts";
import * as formatting from "./composer-dictation-formatting.ts";
import type {
  ComposerDictationCommits,
  ComposerDictationSession,
  placeComposerDictation,
} from "./composer-dictation-session.ts";
import type { RealtimeTalkLevelSignal } from "./talk/level.ts";

const HOLD_ARM_DELAY_MS = 150,
  HOLD_PROGRESS_MS = 350;

type DictationPhase = "idle" | "pressing" | "holding" | "connecting" | "recording" | "stopping";

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
  private captureStart: object | undefined;
  private session: ComposerDictationSession | null = null;
  private suppressedPointerId: number | null = null;
  private suppressClickTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  // Created with the lazy capture module, before the first transcript exists.
  private commits: ComposerDictationCommits | undefined;
  private disposed = false;
  private mode: formatting.DictationFormattingMode =
    readLiveUiPreferences()?.dictationFormatting?.mode ?? "preserve";
  private captureMode: formatting.DictationFormattingMode = "preserve";
  private policyRevision = 0;
  private capturePolicyRevision = 0;
  private prepareFormatting: formatting.PrepareFormatting | undefined;
  private preparationGeneration = 0;
  private formattingCapture: formatting.DictationFormattingCapture | undefined;
  private review: formatting.DictationFormattingReview | undefined;
  private lastReceipt: formatting.DictationFormattingReceipt = "not-committed";
  private readonly stopSettings: () => void;

  constructor(private options: formatting.ComposerDictationOwnerOptions) {
    super();
    this.stopSettings = subscribeSettingsChanges((previous, next) => {
      if (formatting.policyChanged(previous, next)) {
        this.refreshFormattingPolicy();
      }
    });
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
    return Boolean(this.commits?.size);
  }

  get locksComposer(): boolean {
    return this.phase !== "idle" && (this.active ? this.captureMode : this.mode) === "preserve";
  }

  /** Places a transcript in a draft; there is nothing to place before capture loads. */
  placeTranscript(
    ...args: Parameters<typeof placeComposerDictation>
  ): ReturnType<typeof placeComposerDictation> | undefined {
    return this.commits?.place(...args);
  }

  get inputLevel(): RealtimeTalkLevelSignal | undefined {
    return this.session?.inputLevel;
  }

  get transcript(): string {
    return this.session?.transcriptSnapshot() ?? "";
  }

  get formattingMode(): formatting.DictationFormattingMode {
    return this.mode;
  }

  /** Snapshot this before awaiting Stop: a review must never resume an automatic Send. */
  get requiresFormattingReview(): boolean {
    return this.captureMode === "explicit" || this.review !== undefined;
  }

  get formattingReceipt(): formatting.DictationFormattingReceipt {
    return this.lastReceipt;
  }

  /** Bounded local diagnostics contain no transcript, target value, or credentials. */
  get formattingDiagnostics() {
    return formatting.diagnostics(this.review);
  }

  get formattingReview() {
    return formatting.reviewProjection(
      this.review,
      (review) => this.reviewIsCurrent(review),
      () => this.options.readFormattingTarget?.(),
    );
  }

  setFormattingMode(mode: formatting.DictationFormattingMode): void {
    patchSettings({ dictationFormatting: { version: 1, mode } });
    if (this.mode !== mode) {
      this.policyRevision++;
    }
    this.mode = mode;
    this.invalidateFormattingReview();
  }

  reprocessFormatting(): void {
    this.refreshFormattingPolicy();
    const review = this.review;
    if (
      !review ||
      review.receipt !== "not-committed" ||
      !this.prepareFormatting ||
      !this.sourceIsCurrent(review)
    ) {
      return;
    }
    const result = formatting.prepareReview(this.prepareFormatting, review, this.mode);
    this.review = {
      ...review,
      result,
      generation: ++this.preparationGeneration,
      mode: this.mode,
      invalidated: false,
    };
    // Reprocessing cannot retarget an edited draft or reacquire a lost selection.
    this.dispatchEvent(new Event("change"));
  }

  confirmFormattingMarkers(ranges: readonly { start: number; end: number }[]): void {
    this.refreshFormattingPolicy();
    const review = this.review;
    if (
      !review ||
      !this.reviewIsCurrent(review) ||
      !review.source.finalized ||
      this.mode !== "explicit"
    ) {
      return;
    }
    const result = formatting.prepareReview(this.prepareFormatting!, review, this.mode, ranges);
    this.review = { ...review, result, generation: ++this.preparationGeneration };
    this.dispatchEvent(new Event("change"));
  }

  acceptFormatting(choice: "formatted" | "original"): boolean {
    this.refreshFormattingPolicy();
    const review = this.review;
    if (!review || !this.reviewIsCurrent(review)) {
      return false;
    }
    const selection = formatting.selectDictationFormatting(
      review.result,
      review.target,
      this.options.readFormattingTarget?.(),
      choice === "original",
    );
    if (!selection.canApply) {
      review.invalidated = true;
      this.dispatchEvent(new Event("change"));
      return false;
    }
    // Set the receipt before the indivisible attempt. A callback can cancel/reenter;
    // that cannot authorize another write or make an uncertain effect disappear.
    review.receipt = "outcome-unknown";
    this.lastReceipt = review.receipt;
    try {
      const committed = this.options.onCommit(selection.text, true, undefined, {
        target: review.target!,
        format: selection.format,
        isCurrent: () =>
          this.review === review &&
          this.options.enabled &&
          this.sourceIsCurrent(review) &&
          !review.invalidated &&
          review.mode === this.mode &&
          review.generation === this.preparationGeneration &&
          formatting.selectDictationFormatting(
            review.result,
            review.target,
            this.options.readFormattingTarget?.(),
            choice === "original",
          ).canApply,
      });
      review.receipt = formatting.commitReceipt(committed);
    } catch {
      review.receipt = "outcome-unknown";
    }
    review.invalidated = true;
    this.lastReceipt = review.receipt;
    this.dispatchEvent(new Event("change"));
    return review.receipt === "committed";
  }

  dismissFormatting(): void {
    this.review = undefined;
    const generation = ++this.preparationGeneration;
    this.pendingCommitsChanged();
    this.restoreFormattingFocus(generation);
  }

  private sourceIsCurrent(review: formatting.DictationFormattingAuthority): boolean {
    return (
      !this.disposed &&
      this.options.connected &&
      !this.options.realtimeTalkActive &&
      this.options.client === review.client &&
      review.client.auth === review.auth &&
      review.client.connectionGeneration === review.connection
    );
  }

  private refreshFormattingPolicy(): void {
    const mode =
      (readLiveUiPreferences() ?? loadUiPreferences()).dictationFormatting?.mode ?? "preserve";
    if (mode !== this.mode) {
      this.mode = mode;
      this.policyRevision++;
      this.invalidateFormattingReview();
    }
  }

  private readonly handleSettingsStorage = (event: StorageEvent): void => {
    const { gatewayUrl } = readLiveUiPreferences() ?? loadUiPreferences();
    if (event.key === null || event.key === settingsKeyForGateway(gatewayUrl)) {
      // Storage events retain intervening writes even when another tab changes A→B→A.
      this.policyRevision++;
      this.refreshFormattingPolicy();
      this.invalidateFormattingReview();
    }
  };

  private reviewIsCurrent(review: formatting.DictationFormattingReview): boolean {
    return (
      this.options.enabled &&
      this.sourceIsCurrent(review) &&
      !review.invalidated &&
      review.generation === this.preparationGeneration &&
      review.mode === this.mode &&
      review.receipt === "not-committed"
    );
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

  update(options: formatting.ComposerDictationOwnerOptions): void {
    if (formatting.scopeChanged(this.options, options)) {
      this.cancel(false);
    }
    this.options = options;
    const preferences = readLiveUiPreferences();
    const mode = preferences ? (preferences.dictationFormatting?.mode ?? "preserve") : this.mode;
    if (this.mode !== mode) {
      this.mode = mode;
      this.policyRevision++;
      if (this.review) {
        this.review.invalidated = true;
      }
    }
    if (this.review && !this.sourceIsCurrent(this.review)) {
      this.review = undefined;
      this.preparationGeneration++;
    }
    this.observeFormattingTarget();
    if (!options.connected) {
      this.commits?.markGatewayDisconnected();
    }
    if (this.phase === "stopping") {
      return;
    }
    if (this.phase !== "idle" && !this.canHold()) {
      const keepFinal = this.active && !options.connected;
      const preservesText = keepFinal ? (this.session?.markGatewayDisconnected() ?? false) : false;
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
    this.stopSettings();
    this.cancel(false);
  }

  cancel(restoreFormattingFocus = true): void {
    const hadReview = this.review !== undefined;
    const restoreFocus =
      restoreFormattingFocus &&
      !this.disposed &&
      (hadReview || (this.captureMode === "explicit" && this.transcribing));
    this.review = undefined;
    this.formattingCapture = undefined;
    const generation = ++this.preparationGeneration;
    this.clearClickSuppression();
    this.playback.stop();
    // Capture phases report their own changes; an idle scope change has nothing to publish.
    if (this.transcribing || hadReview) {
      this.commits?.retire();
      this.pendingCommitsChanged();
    }
    void this.stop({ commit: false });
    if (restoreFocus) {
      this.restoreFormattingFocus(generation);
    }
  }

  private restoreFormattingFocus(generation: number): void {
    if (!this.disposed && generation === this.preparationGeneration) {
      this.options.onFormattingDismiss?.();
    }
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
    if (event.key !== "Escape" || (this.phase === "idle" && !this.transcribing && !this.review)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.cancel();
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

  private readonly observeFormattingTarget = (event?: Event): void => {
    const capture = this.formattingCapture;
    if (
      (capture || this.review) &&
      formatting.formattingTargetChanged(
        capture,
        this.options.readFormattingTarget,
        this.connecting,
        event,
      )
    ) {
      if (capture) {
        capture.invalidated = true;
      }
      this.invalidateFormattingReview();
    }
  };

  private invalidateFormattingReview(): void {
    if (this.review) {
      this.review.invalidated = true;
    }
    this.dispatchEvent(new Event("change"));
  }

  private canHold(): boolean {
    return (
      this.options.enabled &&
      this.options.connected &&
      !this.options.realtimeTalkActive &&
      this.options.client !== null &&
      this.review === undefined &&
      !((this.mode === "explicit" || this.captureMode === "explicit") && this.transcribing)
    );
  }

  private async start(): Promise<void> {
    this.refreshFormattingPolicy();
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
    const captureStart = {};
    this.captureStart = captureStart;
    this.captureMode = this.mode;
    this.capturePolicyRevision = this.policyRevision;
    this.preparationGeneration++;
    this.setPhase("connecting");
    this.formattingCapture =
      this.captureMode === "explicit"
        ? formatting.captureTarget(this.options.readFormattingTarget?.(), client)
        : undefined;
    if (this.captureStart !== captureStart) {
      return;
    }
    let describeStartError = (
      error: unknown,
    ): [string, formatting.ComposerDictationFailure["kind"]] => [formatUiError(error), "start"];
    try {
      // Preserve Safari playback activation before the lazy capture module loads.
      this.playback.prepare(client, () => this.cancel(false));
      const sessionKey = this.options.prepareSession
        ? await this.options.prepareSession()
        : this.options.sessionKey;
      const { ComposerDictationSession, ComposerDictationCommits, describeDictationStartError } =
        await import("./composer-dictation-session.ts");
      if (this.captureMode === "explicit") {
        const { prepareDictationFormatting } = await import("../../lib/dictation/formatting.ts");
        this.prepareFormatting = prepareDictationFormatting;
      }
      if (
        this.captureStart !== captureStart ||
        this.disposed ||
        !this.connecting ||
        !this.canHold()
      ) {
        return;
      }
      describeStartError = describeDictationStartError;
      const commits = (this.commits ??= new ComposerDictationCommits());
      const session = new ComposerDictationSession(
        client,
        {
          onError: (message, preservesText) => {
            if (this.session !== session && !commits.has(session)) {
              return;
            }
            try {
              this.options.onError(message, { kind: "interrupted", preservesText });
            } finally {
              if (this.session === session) {
                void this.stop({ commit: true });
              } else if (commits.has(session)) {
                this.dispatchEvent(new Event("change"));
              }
            }
          },
          onTranscriptChange: () => this.dispatchEvent(new Event("change")),
          onReady: () => {
            if (this.session === session && this.phase === "connecting") {
              this.setPhase("recording");
            }
          },
        },
        {
          sessionKey,
          ...(this.captureMode === "explicit" ? { finalizationDeadlineMs: 2_500 } : {}),
        },
      );
      this.session = session;
      await session.start();
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
    this.captureStart = undefined;
    if (this.phase === "idle" || this.phase === "stopping") {
      return Promise.resolve(false);
    }
    const wasActive = this.active;
    this.clearPointerGesture();
    const session = this.session;
    if (!session) {
      this.setPhase("idle");
      this.releasePlayback();
      return Promise.resolve(false);
    }
    const preparation = formatting.finalPreparation(
      this.captureMode,
      this.preparationGeneration,
      this.formattingCapture,
      this.options.client!,
    );
    const policyRevision = this.capturePolicyRevision;
    this.setPhase("stopping");
    this.session = null;
    this.setPhase("idle");
    if (
      !options.commit ||
      (preparation.mode === "explicit" && preparation.generation !== this.preparationGeneration)
    ) {
      this.releasePlayback();
      void session.cancel().catch(() => undefined);
      return Promise.resolve(false);
    }
    // Capture and typing unlock immediately. Stopped recordings retain ownership
    // and commit in capture order, even when a later provider finishes first.
    const committed = this.commits!.add(session, (lateTranscript) => {
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
      if (preparation.mode === "explicit" && this.prepareFormatting) {
        if (
          preparation.generation !== this.preparationGeneration ||
          !this.sourceIsCurrent(preparation)
        ) {
          return false;
        }
        const review = formatting.prepareFinalReview(
          this.prepareFormatting,
          lateTranscript,
          session,
          preparation,
        );
        review.invalidated ||= this.policyRevision !== policyRevision;
        this.review = review;
        this.lastReceipt = "not-committed";
        this.pendingCommitsChanged();
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
    if (this.phase !== "idle" || this.transcribing || this.review) {
      if (this.cancellationListeners) {
        return;
      }
      this.cancellationListeners = new AbortController();
      const options = { signal: this.cancellationListeners.signal };
      listen(document, "keydown", this.handleDocumentKeyDown, options);
      listen(document, "visibilitychange", this.observeFormattingTarget, options);
      listen(window, "blur", this.observeFormattingTarget, options);
      listen(document, "focusin", this.observeFormattingTarget, options);
      listen(document, "input", this.observeFormattingTarget, options);
      listen(document, "selectionchange", this.observeFormattingTarget, options);
      listen(window, "storage", this.handleSettingsStorage, options);
    } else {
      this.cancellationListeners?.abort();
      this.cancellationListeners = null;
    }
  }
}
