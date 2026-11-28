import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { GatewaySpeechPlayback } from "../../lib/speech-playback.ts";
import type { ComposerDictationCapture } from "./composer-dictation-capture.ts";
import type {
  ComposerDictationFailure,
  ComposerDictationOwnerOptions,
} from "./composer-dictation-owner-options.ts";
import type { placeComposerDictation } from "./composer-dictation-session.ts";
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
  private captureStart: { literal?: boolean } | undefined;
  private capture: ComposerDictationCapture | undefined;
  private suppressedPointerId: number | null = null;
  private suppressClickTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private disposed = false;
  private nextLiteral = false;

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
    return this.capture?.transcribing ?? false;
  }

  get locksComposer(): boolean {
    return this.phase !== "idle";
  }

  /** Places a transcript in a draft; there is nothing to place before capture loads. */
  placeTranscript(
    ...args: Parameters<typeof placeComposerDictation>
  ): ReturnType<typeof placeComposerDictation> | undefined {
    return this.capture?.place(...args);
  }

  get inputLevel(): RealtimeTalkLevelSignal | undefined {
    return this.capture?.inputLevel;
  }

  get transcript(): string {
    return this.capture?.transcript ?? "";
  }

  get correctionCommitRequired(): boolean {
    return (
      this.captureStart?.literal !== undefined || (this.capture?.correctionCommitRequired ?? false)
    );
  }

  get literal(): boolean {
    return this.active ? (this.captureStart?.literal ?? false) : this.nextLiteral;
  }

  /** Literal applies to one explicitly selected recording and is never persisted. */
  setLiteral(literal: boolean): void {
    if (this.phase !== "idle") {
      return;
    }
    this.nextLiteral = literal;
    this.dispatchEvent(new Event("change"));
  }

  get correctionReview() {
    return this.capture?.correctionReview ?? null;
  }

  resolveCorrection(choice: "original" | "cancel"): boolean {
    if (choice === "cancel") {
      this.cancel();
      return true;
    }
    return this.capture?.keepOriginal() ?? false;
  }

  // Returns the stop promise so the confirming control can remain tied to the
  // session that actually inserted text into the draft.
  finishActive(): Promise<boolean> {
    return this.stop({ commit: true });
  }

  startDirect(): boolean {
    if (this.phase !== "idle" || this.correctionCommitRequired || !this.canHold()) {
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
      this.options.draftKey !== options.draftKey ||
      this.options.contextKey !== options.contextKey ||
      (this.correctionCommitRequired && (!options.enabled || options.realtimeTalkActive))
    ) {
      this.cancel();
    }
    const wasConnected = this.options.connected;
    this.options = options;
    if (!options.connected) {
      this.capture?.disconnect(wasConnected);
    }
    if (this.phase === "stopping") {
      return;
    }
    if (this.phase !== "idle" && !this.canHold()) {
      const keepFinal = this.active && !options.connected;
      const preservesText = keepFinal ? this.capture?.markRecordingDisconnected() : false;
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
    if (
      event.button !== 0 ||
      this.phase !== "idle" ||
      this.correctionCommitRequired ||
      !this.canHold()
    ) {
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
    this.cancel();
  }

  cancel(): void {
    this.nextLiteral = false;
    this.clearClickSuppression();
    this.playback.stop();
    this.capture?.retire();
    void this.stop({ commit: false });
    this.syncCancellationListeners();
    if (!this.disposed) {
      this.dispatchEvent(new Event("change"));
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
    if (
      event.defaultPrevented ||
      event.key !== "Escape" ||
      (this.phase === "idle" && !this.transcribing && !this.correctionCommitRequired)
    ) {
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

  private canHold(): boolean {
    return (
      this.options.enabled &&
      this.options.connected &&
      !this.options.realtimeTalkActive &&
      this.options.client !== null
    );
  }

  private async start(): Promise<void> {
    // The delayed hold must not retire an unresolved Explicit or Literal capture.
    if (this.correctionCommitRequired) {
      this.clearPointerGesture();
      if (this.phase === "holding") {
        this.setPhase("idle");
      }
      return;
    }
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
    const literal = this.options.corrections?.mode === "explicit" ? this.nextLiteral : undefined;
    const isDraftCurrent = literal !== undefined ? this.options.captureDraftGuard?.() : undefined;
    const captureStart = { literal };
    this.nextLiteral = false;
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
      const { ComposerDictationCapture, describeDictationStartError } =
        await import("./composer-dictation-capture.ts");
      if (
        this.captureStart !== captureStart ||
        this.disposed ||
        !this.connecting ||
        !this.canHold()
      ) {
        return;
      }
      describeStartError = describeDictationStartError;
      const capture = (this.capture ??= new ComposerDictationCapture({
        options: () => this.options,
        active: () => this.active,
        ready: () => {
          if (this.connecting) {
            this.setPhase("recording");
          }
        },
        idle: () => this.setPhase("idle"),
        interrupted: () => void this.stop({ commit: true }),
        changed: () => this.dispatchEvent(new Event("change")),
        commitsChanged: () => this.pendingCommitsChanged(),
      }));
      await capture.start(client, sessionKey, literal, isDraftCurrent);
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
    if (!this.capture?.recording) {
      this.setPhase("idle");
      this.releasePlayback();
      return Promise.resolve(false);
    }
    this.setPhase("stopping");
    return this.capture.stop(options.commit, wasActive);
  }

  private releasePlayback(): void {
    if (this.phase === "idle" && !this.transcribing) {
      this.playback.stop();
    }
  }

  private pendingCommitsChanged(): void {
    this.releasePlayback();
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
    if (this.phase !== "idle" || this.transcribing || this.correctionCommitRequired) {
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
